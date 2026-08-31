import type {
InstallCompareOptions,
InstallStatusProgressPayload,
InstallStatusRefreshResult,
InstallStatusRefreshStartResult,
} from "../../shared/types";

export type ActiveInstallStatusRefreshJob = {
  jobId: string;
  startedAt: number;
};

type EmitInstallStatusProgress = (
  payload: Omit<InstallStatusProgressPayload, "at"> & { at?: string },
) => void;

export type InstallStatusRefreshStarterRuntimeOptions = {
  createInstallStatusRefreshJobId: () => string;
  refreshInstallStatusIndex: (
    options?: InstallCompareOptions,
    runtime?: { jobId?: string; emitProgress?: boolean },
  ) => Promise<InstallStatusRefreshResult>;
  emitInstallStatusProgress: EmitInstallStatusProgress;
  appendLog: (message: string) => void;
  now?: () => number;
};

export type InstallStatusRefreshStarterRuntime = {
  startInstallStatusRefreshIndex: (
    options?: InstallCompareOptions,
  ) => InstallStatusRefreshStartResult;
  activeInstallStatusRefreshJob: () => ActiveInstallStatusRefreshJob | null;
};

export function createInstallStatusRefreshStarterRuntime(
  options: InstallStatusRefreshStarterRuntimeOptions,
): InstallStatusRefreshStarterRuntime {
  let activeInstallStatusRefreshJob: ActiveInstallStatusRefreshJob | null =
    null;
  const now = options.now || Date.now;

  function startInstallStatusRefreshIndex(
    refreshOptions: InstallCompareOptions = {},
  ): InstallStatusRefreshStartResult {
    if (activeInstallStatusRefreshJob) {
      return {
        started: false,
        running: true,
        jobId: activeInstallStatusRefreshJob.jobId,
        message: "已安装状态正在后台刷新，本次请求已合并。",
      };
    }

    const jobId = options.createInstallStatusRefreshJobId();
    activeInstallStatusRefreshJob = { jobId, startedAt: now() };

    void Promise.resolve()
      .then(() =>
        options.refreshInstallStatusIndex(refreshOptions || {}, {
          jobId,
          emitProgress: true,
        }),
      )
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        options.appendLog(
          `install status refresh failed: job=${jobId}, ${message}`,
        );
        options.emitInstallStatusProgress({
          jobId,
          stage: "error",
          message: `已安装状态后台刷新失败：${message}`,
          elapsedMs: activeInstallStatusRefreshJob
            ? now() - activeInstallStatusRefreshJob.startedAt
            : undefined,
        });
      })
      .finally(() => {
        if (activeInstallStatusRefreshJob?.jobId === jobId)
          activeInstallStatusRefreshJob = null;
      });

    return {
      started: true,
      running: true,
      jobId,
      message:
        refreshOptions.force === true && refreshOptions.incremental !== true
          ? "已安装状态已转入后台全量刷新，列表可以继续操作。"
          : "已安装状态已转入后台增量刷新，列表可以继续操作。",
    };
  }

  return {
    startInstallStatusRefreshIndex,
    activeInstallStatusRefreshJob: () => activeInstallStatusRefreshJob,
  };
}
