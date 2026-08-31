import { resolve } from "node:path";
import type { LibraryShell } from "../../shared/types";
import type { RootIndexSnapshotMaintenanceReport } from "../indexing/root-index/rootIndexSnapshotRuntime";

export type SharedIndexSnapshotAutoMaintenanceRootReport =
  RootIndexSnapshotMaintenanceReport & {
    rootPath: string;
    cleaned: boolean;
    before?: Pick<
      RootIndexSnapshotMaintenanceReport,
      "staleSnapshotCount" | "orphanSidecarCount" | "tmpFileCount"
    >;
  };

export type SharedIndexSnapshotAutoMaintenanceReport = {
  ok: boolean;
  enabled: boolean;
  checkedRoots: number;
  cleanedRoots: number;
  deletedFiles: number;
  warnings: string[];
  roots: SharedIndexSnapshotAutoMaintenanceRootReport[];
};

export type SharedIndexSnapshotAutoMaintenanceRuntimeDeps = {
  loadLibraryShell: () => Promise<LibraryShell>;
  rootCacheDir: (rootPath: string) => string;
  rootIndexDbPath: (rootPath: string) => string;
  inspectRootIndexSnapshotMaintenance: (
    cacheDir: string,
    defaultDbPath: string,
  ) => Promise<RootIndexSnapshotMaintenanceReport>;
  cleanupRootIndexSnapshotMaintenance: (
    cacheDir: string,
    defaultDbPath: string,
  ) => Promise<RootIndexSnapshotMaintenanceReport>;
  appendStartupLog: (message: string) => void;
};

function sharedIndexAutoMaintenanceEnabled(): boolean {
  return process.env.HFM_SHARED_INDEX_AUTO_MAINTENANCE !== "0";
}

function shouldCleanupSnapshotReport(report: RootIndexSnapshotMaintenanceReport): boolean {
  return (
    report.staleSnapshotCount > 0 ||
    report.orphanSidecarCount > 0 ||
    report.tmpFileCount > 0
  );
}

function summarizeSnapshotReport(report: RootIndexSnapshotMaintenanceReport): string {
  return [
    `snapshots=${report.snapshotCount}`,
    `stale=${report.staleSnapshotCount}`,
    `tmp=${report.tmpFileCount}`,
    `orphanSidecars=${report.orphanSidecarCount}`,
    `deleted=${report.deletedFiles.length}`,
  ].join(", ");
}

export function createSharedIndexSnapshotAutoMaintenanceRuntime(
  deps: SharedIndexSnapshotAutoMaintenanceRuntimeDeps,
) {
  async function collectWatchedRoots(): Promise<string[]> {
    const shell = await deps.loadLibraryShell();
    const roots = new Set<string>();
    for (const raw of shell.folders || []) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      roots.add(resolve(raw));
    }
    return Array.from(roots);
  }

  async function runSharedIndexSnapshotAutoMaintenance(): Promise<SharedIndexSnapshotAutoMaintenanceReport> {
    const warnings: string[] = [];
    const roots: SharedIndexSnapshotAutoMaintenanceRootReport[] = [];
    if (!sharedIndexAutoMaintenanceEnabled()) {
      return {
        ok: true,
        enabled: false,
        checkedRoots: 0,
        cleanedRoots: 0,
        deletedFiles: 0,
        warnings: ["shared index snapshot auto maintenance disabled by HFM_SHARED_INDEX_AUTO_MAINTENANCE=0"],
        roots,
      };
    }

    let watchedRoots: string[] = [];
    try {
      watchedRoots = await collectWatchedRoots();
    } catch (error) {
      const message = `shared index snapshot auto maintenance root lookup failed: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(message);
      deps.appendStartupLog(message);
    }

    for (const rootPath of watchedRoots) {
      const cacheDir = deps.rootCacheDir(rootPath);
      const defaultDbPath = deps.rootIndexDbPath(rootPath);
      try {
        const inspected = await deps.inspectRootIndexSnapshotMaintenance(cacheDir, defaultDbPath);
        if (!shouldCleanupSnapshotReport(inspected)) {
          roots.push({ ...inspected, rootPath, cleaned: false });
          continue;
        }

        const cleaned = await deps.cleanupRootIndexSnapshotMaintenance(cacheDir, defaultDbPath);
        roots.push({
          ...cleaned,
          rootPath,
          cleaned: true,
          before: {
            staleSnapshotCount: inspected.staleSnapshotCount,
            orphanSidecarCount: inspected.orphanSidecarCount,
            tmpFileCount: inspected.tmpFileCount,
          },
        });
        deps.appendStartupLog(
          `shared index snapshot auto maintenance cleaned: root=${rootPath}, before=${summarizeSnapshotReport(inspected)}, after=${summarizeSnapshotReport(cleaned)}`,
        );
      } catch (error) {
        const message = `shared index snapshot auto maintenance failed: root=${rootPath}, ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        deps.appendStartupLog(message);
      }
    }

    const deletedFiles = roots.reduce((sum, item) => sum + item.deletedFiles.length, 0);
    const cleanedRoots = roots.filter((item) => item.cleaned).length;
    const ok = warnings.length === 0 && roots.every((item) => item.ok || (item.staleSnapshotCount === 0 && item.orphanSidecarCount === 0 && item.tmpFileCount > 0));
    return {
      ok,
      enabled: true,
      checkedRoots: roots.length,
      cleanedRoots,
      deletedFiles,
      warnings,
      roots,
    };
  }

  return { runSharedIndexSnapshotAutoMaintenance };
}
