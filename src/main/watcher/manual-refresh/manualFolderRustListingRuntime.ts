import type { CachedFontStatLike } from "../../fonts/fontRuntime";
import { executeSharedFile } from "../../path/sharedFileSystemRuntime";
import { sharedIoResourceKeys } from "../../rust-core/rustSharedIoCommandRuntime";
import { throwIfAborted } from "../../performance/ioQueue";
import { sharedWatcherInventory } from "../sharedWatcherInventoryRuntime";
import { validatedWatcherInventoryRows } from "../watched-folder-index/watchedFolderInventoryRuntime";
import type { ManualFolderRefreshDeps } from "./manualFolderRefreshTypes";

export type ManualRefreshListedFont = {
  file: string;
  rootPath: string;
  stat: CachedFontStatLike | null;
  error: string;
};

export type ManualRustListingResult = {
  rows: ManualRefreshListedFont[];
  complete: true;
  durationMs: number;
};

export function createManualFolderRustListingRuntime(deps: ManualFolderRefreshDeps) {
  async function tryListManualRefreshWithRust(args: {
    rootPath: string;
    targetFolder: string;
    signal?: AbortSignal;
    progress?: (payload: { files: number; foldersScanned: number; skippedDirs: number }) => void;
  }): Promise<ManualRustListingResult | null> {
    throwIfAborted(args.signal);
    const mode = String(process.env.HFM_RUST_MANUAL_REFRESH_LISTING || "auto").trim().toLowerCase();
    if (["0", "false", "off"].includes(mode)) return null;
    if (!(await sharedIoResourceKeys([args.targetFolder])).length) return null;
    throwIfAborted(args.signal);
    const startedAt = Date.now();
    // treeSnapshot propagates every iterator/metadata error and publishes only a
    // complete inventory. list-font-files opens contents and skips iterator errors;
    // it must never be the deletion authority for this metadata comparison.
    const { result } = await executeSharedFile({ operation: "treeSnapshot", path: args.targetFolder }, undefined, args.signal);
    throwIfAborted(args.signal);
    const inventory = sharedWatcherInventory(args.targetFolder, result.value);
    const rows = validatedWatcherInventoryRows(args.targetFolder, inventory, deps.fontExtensions)
      .map(({ file, freshStat }) => ({ file, rootPath: args.rootPath, stat: freshStat, error: "" }));
    args.progress?.({ files: rows.length, foldersScanned: 0, skippedDirs: 0 });
    deps.appendStartupLog(`manual folder refresh listing source=metadata-inventory files=${rows.length}, complete=true, contentReads=0, durationMs=${Date.now() - startedAt}`);
    return { rows, complete: true, durationMs: Date.now() - startedAt };
  }

  return { tryListManualRefreshWithRust };
}

export type ManualFolderRustListingRuntime = ReturnType<typeof createManualFolderRustListingRuntime>;
