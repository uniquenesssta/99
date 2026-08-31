import {
createBackgroundTaskSchedulerRuntime,
type BackgroundTaskSchedulerStatus,
} from "./backgroundTaskSchedulerRuntime";

type BackgroundTaskEventType =
  | "started"
  | "progress"
  | "finished"
  | "failed"
  | "skipped"
  | "scheduler";

export type MainBackgroundTaskSchedulerRuntimeOptions = {
  intervalMs: number;
  concurrency: number;
  batchSize: number;
  startDelayMs: number;
  recoverScanTasks: boolean;
  appendLog: (message: string) => void;
  sendToRendererWindows: (channel: string, payload?: unknown) => void;
  isRendererUserActive: () => boolean;
  rendererIdleInMs: () => number;
  rendererActivityReason: () => string;
  readDueBackgroundTasks: (...args: any[]) => any;
  startBackgroundTask: (...args: any[]) => any;
  skipBackgroundTask: (...args: any[]) => any;
  failBackgroundTask: (...args: any[]) => any;
  runInstallStatusTask: (...args: any[]) => any;
  runPreviewCacheTask: (...args: any[]) => any;
  runScanRootTask: (...args: any[]) => any;
  runMaintenanceTask: (...args: any[]) => any;
};

export type MainBackgroundTaskSchedulerRuntime = {
  activeCount: () => number;
  runBackgroundTaskSchedulerOnce: () => Promise<void>;
  backgroundTaskSchedulerStatus: () => BackgroundTaskSchedulerStatus;
  startBackgroundTaskScheduler: () => void;
  stopBackgroundTaskScheduler: () => void;
  emitBackgroundTaskEvent: (
    eventType: BackgroundTaskEventType,
    payload?: Record<string, unknown>,
  ) => void;
};

export function createMainBackgroundTaskSchedulerRuntime(
  options: MainBackgroundTaskSchedulerRuntimeOptions,
): MainBackgroundTaskSchedulerRuntime {
  const schedulerRuntime = createBackgroundTaskSchedulerRuntime({
    intervalMs: options.intervalMs,
    concurrency: options.concurrency,
    batchSize: options.batchSize,
    startDelayMs: options.startDelayMs,
    recoverScanTasks: options.recoverScanTasks,
    appendLog: options.appendLog,
    sendEvent: (eventType, payload = {}) => {
      options.sendToRendererWindows("background-tasks:changed", {
        eventType,
        ...payload,
      });
    },
    isUserActive: options.isRendererUserActive,
    userIdleInMs: options.rendererIdleInMs,
    userActivityReason: options.rendererActivityReason,
    readDueTasks: options.readDueBackgroundTasks,
    startTask: options.startBackgroundTask,
    skipTask: options.skipBackgroundTask,
    failTask: options.failBackgroundTask,
    taskRunners: {
      checkInstallStatus: options.runInstallStatusTask,
      generatePreview: options.runPreviewCacheTask,
      scanRoot: options.runScanRootTask,
      maintenance: options.runMaintenanceTask,
    },
  });

  const backgroundTaskSchedulerStatus = (): BackgroundTaskSchedulerStatus =>
    schedulerRuntime.status();

  return {
    activeCount: () => schedulerRuntime.activeCount(),
    runBackgroundTaskSchedulerOnce: () => schedulerRuntime.runOnce(),
    backgroundTaskSchedulerStatus,
    startBackgroundTaskScheduler: () => schedulerRuntime.start(),
    stopBackgroundTaskScheduler: () => schedulerRuntime.stop(),
    emitBackgroundTaskEvent: (
      eventType: BackgroundTaskEventType,
      payload: Record<string, unknown> = {},
    ) => schedulerRuntime.emitEvent(eventType, payload),
  };
}
