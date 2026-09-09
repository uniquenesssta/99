import type { BackgroundTaskRuntimeApi, TaskRuntimeOptions } from './background-runtime/backgroundTaskTypes';
import type { BackgroundTaskRunnersRuntimeOptions } from './backgroundTaskRunnersRuntime';
import { createBackgroundTaskRunnersRuntime } from "./backgroundTaskRunnersRuntime";
import { createBackgroundTaskRuntime } from "./backgroundTasks";
import type { MainBackgroundTaskSchedulerRuntimeOptions } from './mainBackgroundTaskSchedulerRuntime';
import {
  createMainBackgroundTaskSchedulerRuntime,
  type MainBackgroundTaskSchedulerRuntime,
} from "./mainBackgroundTaskSchedulerRuntime";

type BackgroundTaskEventType =
  | "started"
  | "progress"
  | "finished"
  | "failed"
  | "skipped"
  | "scheduler";

export type MainBackgroundRuntime = Pick<BackgroundTaskRuntimeApi,
  'closeTasksDb' | 'checkpointTasksDb' | 'upsertBackgroundTask' | 'startBackgroundTask' |
  'heartbeatBackgroundTask' | 'completeBackgroundTask' | 'skipBackgroundTask' |
  'failBackgroundTask' | 'listBackgroundTaskSummaries' | 'runTaskMaintenance'
> & {
  schedulerRuntime: MainBackgroundTaskSchedulerRuntime;
  openTasksDb: () => Promise<unknown>;
  getOpenTasksDb: () => unknown;
  previewTaskKey: (previewKey: string) => string;
  runBackgroundTaskSchedulerOnce: () => Promise<void>;
  backgroundTaskSchedulerStatus: () => unknown;
  startBackgroundTaskScheduler: () => void;
  stopBackgroundTaskScheduler: () => void;
  emitBackgroundTaskEvent: (
    eventType: BackgroundTaskEventType,
    payload?: Record<string, unknown>,
  ) => void;
};

export type MainBackgroundRuntimeOptions = Omit<TaskRuntimeOptions, 'getLibraryDb'> &
  Omit<BackgroundTaskRunnersRuntimeOptions, 'skipBackgroundTask' | 'heartbeatBackgroundTask' | 'completeBackgroundTask'> &
  Pick<MainBackgroundTaskSchedulerRuntimeOptions, 'sendToRendererWindows' | 'isRendererUserActive' | 'rendererIdleInMs' | 'rendererActivityReason'> & {
    getOpenLibraryDb: () => unknown;
    backgroundTaskSchedulerIntervalMs: number;
    backgroundTaskSchedulerConcurrency: number;
    backgroundTaskSchedulerBatchSize: number;
    backgroundTaskSchedulerStartDelayMs: number;
  };

export function createMainBackgroundRuntime(deps: MainBackgroundRuntimeOptions): MainBackgroundRuntime {
  const backgroundTaskRuntime = createBackgroundTaskRuntime({
    tasksSqlitePath: deps.tasksSqlitePath,
    openRecoverableApplicationSqliteDb: deps.openRecoverableApplicationSqliteDb,
    closeSqliteDb: deps.closeSqliteDb,
    ensureSqliteColumn: deps.ensureSqliteColumn,
    setSqliteMeta: deps.setSqliteMeta,
    getLibraryDb: deps.getOpenLibraryDb,
    appendStartupLog: deps.appendStartupLog,
    taskSqliteSchemaVersion: deps.taskSqliteSchemaVersion,
    taskLockStaleMs: deps.taskLockStaleMs,
    safeStartupTaskTypes: deps.safeStartupTaskTypes,
    recoverScanTasksOnStartup: deps.recoverScanTasksOnStartup,
    completedTaskRetentionMs: deps.completedTaskRetentionMs,
    failedTaskRetentionMs: deps.failedTaskRetentionMs,
    taskErrorRetentionMs: deps.taskErrorRetentionMs,
  });

  const {
    openTasksDb,
    closeTasksDb,
    getOpenTasksDb,
    checkpointTasksDb,
    upsertBackgroundTask,
    startBackgroundTask,
    heartbeatBackgroundTask,
    completeBackgroundTask,
    skipBackgroundTask,
    failBackgroundTask,
    listBackgroundTaskSummaries,
    readDueBackgroundTasks,
    runTaskMaintenance,
  } = backgroundTaskRuntime;

  const backgroundTaskRunnersRuntime = createBackgroundTaskRunnersRuntime({
    normalizePathForCacheCompare: deps.normalizePathForCacheCompare,
    findFontItemInRootIndexes: (fontId, normalizedPath) =>
      deps.findFontItemInRootIndexes(fontId, normalizedPath),
    skipBackgroundTask,
    heartbeatBackgroundTask,
    completeBackgroundTask,
    getSystemInstalledFontsCached: (force) =>
      deps.getSystemInstalledFontsCached(force),
    compareFontInstalledWithList: deps.compareFontInstalledWithList,
    saveInstallStatusIndex: (results, itemsById) =>
      deps.saveInstallStatusIndex(results, itemsById),
    ensureFontPreviewImageFile: (
      item,
      text,
      fontSize,
      width,
      height,
      force,
      returnDataUrl,
    ) =>
      deps.ensureFontPreviewImageFile(
        item,
        text,
        fontSize,
        width,
        height,
        force,
        returnDataUrl,
      ),
    withGlobalIo: deps.withGlobalIo,
    scanFolders: (folders, knownFonts) =>
      deps.scanFolders(folders, knownFonts),
    runDatabaseMaintenance: (options) => deps.runDatabaseMaintenance(options),
  });

  const {
    previewTaskKey,
    runInstallStatusTask,
    runPreviewCacheTask,
    runScanRootTask,
    runMaintenanceTask,
  } = backgroundTaskRunnersRuntime;

  const schedulerRuntime = createMainBackgroundTaskSchedulerRuntime({
    intervalMs: deps.backgroundTaskSchedulerIntervalMs,
    concurrency: deps.backgroundTaskSchedulerConcurrency,
    batchSize: deps.backgroundTaskSchedulerBatchSize,
    startDelayMs: deps.backgroundTaskSchedulerStartDelayMs,
    recoverScanTasks: deps.recoverScanTasksOnStartup,
    appendLog: deps.appendStartupLog,
    sendToRendererWindows: deps.sendToRendererWindows,
    isRendererUserActive: deps.isRendererUserActive,
    rendererIdleInMs: deps.rendererIdleInMs,
    rendererActivityReason: deps.rendererActivityReason,
    readDueBackgroundTasks,
    startBackgroundTask,
    skipBackgroundTask,
    failBackgroundTask,
    runInstallStatusTask,
    runPreviewCacheTask,
    runScanRootTask,
    runMaintenanceTask,
  });

  return {
    schedulerRuntime,
    openTasksDb,
    closeTasksDb,
    getOpenTasksDb,
    checkpointTasksDb,
    upsertBackgroundTask,
    startBackgroundTask,
    heartbeatBackgroundTask,
    completeBackgroundTask,
    skipBackgroundTask,
    failBackgroundTask,
    listBackgroundTaskSummaries,
    runTaskMaintenance,
    previewTaskKey,
    runBackgroundTaskSchedulerOnce: schedulerRuntime.runBackgroundTaskSchedulerOnce,
    backgroundTaskSchedulerStatus: schedulerRuntime.backgroundTaskSchedulerStatus,
    startBackgroundTaskScheduler: schedulerRuntime.startBackgroundTaskScheduler,
    stopBackgroundTaskScheduler: schedulerRuntime.stopBackgroundTaskScheduler,
    emitBackgroundTaskEvent: schedulerRuntime.emitBackgroundTaskEvent,
  };
}
