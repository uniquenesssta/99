import { resolve } from "node:path";
import type { LibraryShell } from "../../shared/types";
import type { RootIndexSnapshotMaintenanceReport } from "../indexing/root-index/rootIndexSnapshotRuntime";

export type SharedIndexSnapshotFrontendOptions = {
  apply?: boolean;
};

export type SharedIndexSnapshotFrontendRootReport = RootIndexSnapshotMaintenanceReport & {
  rootPath: string;
  cleaned: boolean;
};

export type SharedIndexSnapshotFrontendReport = {
  ok: boolean;
  apply: boolean;
  checkedRoots: number;
  problemRoots: number;
  cleanedRoots: number;
  deletedFiles: number;
  warnings: string[];
  reports: SharedIndexSnapshotFrontendRootReport[];
};

export type SharedIndexSnapshotFrontendRuntimeDeps = {
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

function reportHasSnapshotProblems(report: RootIndexSnapshotMaintenanceReport): boolean {
  return !report.ok || report.staleSnapshotCount > 0 || report.orphanSidecarCount > 0 || report.tmpFileCount > 0;
}

export function createSharedIndexSnapshotFrontendRuntime(deps: SharedIndexSnapshotFrontendRuntimeDeps) {
  async function collectWatchedRoots(): Promise<string[]> {
    const shell = await deps.loadLibraryShell();
    const roots = new Set<string>();
    for (const raw of shell.folders || []) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      roots.add(resolve(raw));
    }
    return Array.from(roots);
  }

  async function runSharedIndexSnapshotFrontendMaintenance(options: SharedIndexSnapshotFrontendOptions = {}): Promise<SharedIndexSnapshotFrontendReport> {
    const apply = !!options.apply;
    const warnings: string[] = [];
    const reports: SharedIndexSnapshotFrontendRootReport[] = [];
    let watchedRoots: string[] = [];

    try {
      watchedRoots = await collectWatchedRoots();
    } catch (error) {
      const message = `shared index snapshot frontend root lookup failed: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(message);
      deps.appendStartupLog(message);
    }

    if (!watchedRoots.length) {
      warnings.push("没有监听根目录，无法检查 shared index snapshot。");
    }

    for (const rootPath of watchedRoots) {
      const cacheDir = deps.rootCacheDir(rootPath);
      const defaultDbPath = deps.rootIndexDbPath(rootPath);
      try {
        const inspected = await deps.inspectRootIndexSnapshotMaintenance(cacheDir, defaultDbPath);
        if (!apply) {
          reports.push({ ...inspected, rootPath, cleaned: false });
          continue;
        }

        if (!reportHasSnapshotProblems(inspected)) {
          reports.push({ ...inspected, rootPath, cleaned: false });
          continue;
        }

        const cleaned = await deps.cleanupRootIndexSnapshotMaintenance(cacheDir, defaultDbPath);
        reports.push({ ...cleaned, rootPath, cleaned: true });
        deps.appendStartupLog(`shared index snapshot frontend cleanup: root=${rootPath}, deleted=${cleaned.deletedFiles.length}`);
      } catch (error) {
        const message = `shared index snapshot frontend maintenance failed: root=${rootPath}, ${error instanceof Error ? error.message : String(error)}`;
        warnings.push(message);
        deps.appendStartupLog(message);
      }
    }

    const problemRoots = reports.filter(reportHasSnapshotProblems).length;
    const cleanedRoots = reports.filter((report) => report.cleaned).length;
    const deletedFiles = reports.reduce((sum, report) => sum + report.deletedFiles.length, 0);

    return {
      ok: warnings.length === 0 && problemRoots === 0,
      apply,
      checkedRoots: reports.length,
      problemRoots,
      cleanedRoots,
      deletedFiles,
      warnings,
      reports,
    };
  }

  return {
    readSharedIndexSnapshotFrontendDiagnostics: () => runSharedIndexSnapshotFrontendMaintenance({ apply: false }),
    repairSharedIndexSnapshotFromFrontend: (options?: SharedIndexSnapshotFrontendOptions) => runSharedIndexSnapshotFrontendMaintenance({ apply: !!options?.apply }),
  };
}
