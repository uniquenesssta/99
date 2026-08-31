import { createManualFolderCacheRepairRuntime } from "./manual-refresh/manualFolderCacheRepairRuntime";
import { createManualFolderIndexApplyRuntime } from "./manual-refresh/manualFolderIndexApplyRuntime";
import { createManualFolderIndexEntryRuntime } from "./manual-refresh/manualFolderIndexEntryRuntime";
import { createManualFolderRefreshBackgroundRuntime } from "./manual-refresh/manualFolderRefreshBackgroundRuntime";
import type { ManualFolderRefreshDeps } from "./manual-refresh/manualFolderRefreshTypes";
import { createManualWatchedFolderRefreshRuntime } from "./manual-refresh/manualWatchedFolderRefreshRuntime";

export type { ManualFolderRefreshDeps } from "./manual-refresh/manualFolderRefreshTypes";

export function createManualFolderRefreshRuntime(deps: ManualFolderRefreshDeps) {
  const indexEntryRuntime = createManualFolderIndexEntryRuntime(deps);
  const cacheRepairRuntime = createManualFolderCacheRepairRuntime(deps);
  const backgroundRuntime = createManualFolderRefreshBackgroundRuntime(deps);
  const indexApplyRuntime = createManualFolderIndexApplyRuntime(
    deps,
    indexEntryRuntime,
  );
  const watchedFolderRefreshRuntime = createManualWatchedFolderRefreshRuntime(
    deps,
    cacheRepairRuntime,
    indexApplyRuntime,
    backgroundRuntime,
  );

  return {
    ...indexEntryRuntime,
    ...cacheRepairRuntime,
    ...indexApplyRuntime,
    ...watchedFolderRefreshRuntime,
  };
}
