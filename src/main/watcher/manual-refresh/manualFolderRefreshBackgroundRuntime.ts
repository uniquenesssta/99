import type { WatchedFolderRefreshResult } from "../../../shared/types";
import type { ManualFolderRefreshDeps } from "./manualFolderRefreshTypes";

export type ManualFolderRefreshBackgroundStart = {
  scheduled: boolean;
  jobId: string;
  startedAt: number;
};

export function createManualFolderRefreshBackgroundRuntime(
  deps: Pick<ManualFolderRefreshDeps, "appendStartupLog">,
) {
  const activeRefreshes = new Map<string, { jobId: string; startedAt: number; completion: Promise<void> }>();

  function activeRefresh(key: string): ManualFolderRefreshBackgroundStart | null {
    const active = activeRefreshes.get(key);
    return active
      ? { scheduled: false, jobId: active.jobId, startedAt: active.startedAt }
      : null;
  }

  function scheduleRefresh(
    key: string,
    jobId: string,
    run: () => Promise<void>,
  ): ManualFolderRefreshBackgroundStart {
    const active = activeRefresh(key);
    if (active) return active;

    const startedAt = Date.now();
    const completion = Promise.resolve().then(run);
    activeRefreshes.set(key, { jobId, startedAt, completion });
    void completion
      .catch((error) => {
        deps.appendStartupLog(
          `manual watched folder background refresh unhandled error: key=${key}, job=${jobId}, ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        const current = activeRefreshes.get(key);
        if (current?.jobId === jobId) activeRefreshes.delete(key);
      });

    return { scheduled: true, jobId, startedAt };
  }

  function backgroundResult(args: {
    folder: string;
    rootPath: string;
    jobId: string;
    elapsedMs: number;
    message: string;
  }): WatchedFolderRefreshResult {
    return {
      ok: true,
      folder: args.folder,
      rootPath: args.rootPath,
      mode: "background",
      cacheRepairs: [],
      upserts: 0,
      deletes: 0,
      errors: 0,
      totalFiles: 0,
      parsed: 0,
      fromCache: 0,
      skippedBad: 0,
      workerCount: 0,
      elapsedMs: args.elapsedMs,
      jobId: args.jobId,
      message: args.message,
    };
  }

  const waitForRefresh = (key: string): Promise<void> => activeRefreshes.get(key)?.completion || Promise.resolve();
  return { activeRefresh, scheduleRefresh, backgroundResult, waitForRefresh };
}

export type ManualFolderRefreshBackgroundRuntime = ReturnType<typeof createManualFolderRefreshBackgroundRuntime>;
