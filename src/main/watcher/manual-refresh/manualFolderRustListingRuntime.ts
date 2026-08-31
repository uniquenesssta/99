import type { ScanResult } from "../../../shared/types";
import type { CachedFontStatLike } from "../../fonts/fontRuntime";
import type {
  RustFontFamilyHint,
  RustFontNameHint,
  RustFontScriptHint,
  RustFontStyleHint,
} from "../../indexing/fontScanWorkers";
import type { RootScanCacheContext } from "../watchedFolderIndexRuntime";
import type { ManualFolderRefreshDeps } from "./manualFolderRefreshTypes";

export type ManualRefreshListedFont = {
  file: string;
  rootPath: string;
  stat: CachedFontStatLike | null;
  error: string;
  signatureValid?: boolean;
  formatHint?: string;
  quickHash?: string;
  contentHash?: string;
  hashKind?: string;
  nameHint?: RustFontNameHint;
  scriptHint?: RustFontScriptHint;
  styleHint?: RustFontStyleHint;
  familyHint?: RustFontFamilyHint;
};

export type ManualRustListingResult = {
  rows: ManualRefreshListedFont[];
  foldersScanned: number;
  durationMs: number;
};

function rustManualRefreshListingMode(): "auto" | "force" | "off" {
  const mode = String(process.env.HFM_RUST_MANUAL_REFRESH_LISTING || "auto")
    .trim()
    .toLowerCase();
  if (mode === "1" || mode === "true" || mode === "on" || mode === "force") return "force";
  if (mode === "0" || mode === "false" || mode === "off") return "off";
  return "auto";
}

function shouldUseRustManualRefreshListing(deps: ManualFolderRefreshDeps, targetFolder: string): boolean {
  const mode = rustManualRefreshListingMode();
  if (mode === "off") return false;
  if (mode === "force") return true;

  const profile = deps.storageProfileForPath?.(targetFolder);
  return profile?.isNetwork !== true;
}

export function createManualFolderRustListingRuntime(
  deps: ManualFolderRefreshDeps,
  relativeDirectoryPathForRoot: (rootPath: string, dirPath: string) => string,
) {
  async function tryListManualRefreshWithRust(args: {
    rootPath: string;
    targetFolder: string;
    context: RootScanCacheContext;
    errors: ScanResult["errors"];
    progress?: (payload: { files: number; foldersScanned: number; skippedDirs: number }) => void;
  }): Promise<ManualRustListingResult | null> {
    if (!deps.runRustFontIndexListWorker) return null;
    if (!shouldUseRustManualRefreshListing(deps, args.targetFolder)) {
      const profile = deps.storageProfileForPath?.(args.targetFolder);
      deps.appendStartupLog(
        `manual folder rust listing skipped: folder=${args.targetFolder}, reason=${profile?.isNetwork ? `network-${profile.reason || profile.type || "path"}` : "disabled"}; directory signature cache preferred`,
      );
      return null;
    }

    const startedAt = Date.now();
    try {
      const listed = await deps.runRustFontIndexListWorker(
        [args.targetFolder],
        Array.from(deps.fontExtensions).map((value) => value.replace(/^\./, "")),
        (payload) =>
          args.progress?.({
            files: payload.files,
            foldersScanned: payload.foldersScanned,
            skippedDirs: 0,
          }),
      );
      if (!listed || listed.truncated) {
        if (listed?.truncated) {
          deps.appendStartupLog(
            `manual folder rust listing skipped: result truncated, folder=${args.targetFolder}`,
          );
        }
        return null;
      }

      for (const item of listed.directories || []) {
        args.context.directoryUpdates.push({
          relativePath: relativeDirectoryPathForRoot(args.rootPath, item.path),
          modifiedAt: Number(item.modifiedMs || 0),
          fileCount: Number(item.fileCount || 0),
          dirCount: Number(item.dirCount || 0),
        });
      }

      args.errors.push(...(listed.errors || []));
      const rows: ManualRefreshListedFont[] = (listed.files || []).map((item) => ({
        file: item.file,
        rootPath: args.rootPath,
        stat: item.stat,
        error: "",
        signatureValid: item.signatureValid,
        formatHint: item.format,
        quickHash: item.quickHash,
        contentHash: item.contentHash,
        hashKind: item.hashKind,
        nameHint: item.nameHint,
        scriptHint: item.scriptHint,
        styleHint: item.styleHint,
        familyHint: item.familyHint,
      }));

      deps.appendStartupLog(
        `manual folder refresh listing source=rust root=${args.rootPath}, folder=${args.targetFolder}, files=${rows.length}, folders=${listed.foldersScanned || 0}, errors=${listed.errors.length}, nameHints=${rows.filter((item) => item.nameHint).length}, scriptHints=${rows.filter((item) => item.scriptHint).length}, styleHints=${rows.filter((item) => item.styleHint).length}, familyHints=${rows.filter((item) => item.familyHint).length}, durationMs=${Date.now() - startedAt}`,
      );
      return {
        rows,
        foldersScanned: Number(listed.foldersScanned || 0),
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      deps.appendStartupLog(
        `manual folder rust listing failed, fallback to Node directory cache listing: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  return { tryListManualRefreshWithRust };
}

export type ManualFolderRustListingRuntime = ReturnType<typeof createManualFolderRustListingRuntime>;
