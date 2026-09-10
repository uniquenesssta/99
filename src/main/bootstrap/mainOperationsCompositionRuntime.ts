import type { FontItem, InstallCompareResult } from '../../shared/types';
import {
  APP_NAME,
  BACKGROUND_TASK_SCHEDULER_BATCH_SIZE,
  BACKGROUND_TASK_SCHEDULER_CONCURRENCY,
  BACKGROUND_TASK_SCHEDULER_INTERVAL_MS,
  BACKGROUND_TASK_SCHEDULER_START_DELAY_MS,
  COMPLETED_TASK_RETENTION_MS,
  FAILED_TASK_RETENTION_MS,
  INSTALL_STATUS_LIGHTWEIGHT_MISSING_THRESHOLD,
  INSTALL_STATUS_REFRESH_BATCH_SIZE,
  SAFE_STARTUP_TASK_TYPES,
  STARTUP_BACKGROUND_TASKS_ENABLED,
  STARTUP_DB_MAINTENANCE_IDLE_DELAY_MS,
  STARTUP_RECOVER_SCAN_TASKS_ENABLED,
  TASK_ERROR_RETENTION_MS,
  TASK_LOCK_STALE_MS
} from '../app/appRuntimeConfig';
import { FONT_EXTENSIONS } from '../bootstrap/mainIndexConstants';
import { TASKS_SQLITE_SCHEMA_VERSION } from '../cache/constants';
import { setSqliteMeta } from '../db/sqliteHelpers';
import { createInstallStatusRefreshRuntime } from '../install/installStatusRefreshRuntime';
import { createInstallStatusRefreshStarterRuntime } from '../install/installStatusRefreshStarterRuntime';
import type { createSharedKnownTagsRuntime } from '../library/sharedKnownTagsRuntime';
import { normalizePathForCacheCompare } from '../path/cachePath';
import { createMainBackgroundRuntime } from '../tasks/mainBackgroundRuntimeBootstrap';
import type { MainOperationsCompositionRuntime } from './mainCompositionContracts';
import type { MainOperationsFeedback } from './mainCompositionFeedback';
import type { createMainCoreCompositionRuntime } from './mainCoreCompositionRuntime';
import type { createMainDataCompositionRuntime } from './mainDataCompositionRuntime';
import { createMainMaintenanceCompositionRuntime } from './mainMaintenanceCompositionRuntime';
import { createMainScanCompositionRuntime } from './mainScanCompositionRuntime';
type Core = ReturnType<typeof createMainCoreCompositionRuntime>;
type Data = ReturnType<typeof createMainDataCompositionRuntime>;

export interface MainOperationsCompositionOptions {
  storage: Pick<Data['storage'],
    | 'tasksSqlitePath'
    | 'openRecoverableApplicationSqliteDb'
    | 'closeSqliteDb'
    | 'ensureSqliteColumn'
    | 'getOpenLibraryDb'
    | 'getSystemInstalledFontsCached'
    | 'saveInstallStatusIndex'
    | 'appWatchedFolders'
    | 'loadSharedFontsForFolders'
    | 'readInstallStatusIndex'
    | 'readInstalledTotalSummaryForRoots'
    | 'saveInstalledTotalSummaryForRoots'
    | 'rootForFontPath'
    | 'sharedMetadataDbPathForRoot'
    | 'openSharedMetadataDb'
    | 'ensureSharedTagOpsBackfilledInOpenDb'
    | 'ensureSharedTagOpsReplayedInOpenDb'
    | 'readSharedTagOpsDiagnosticsInOpenDb'
    | 'readSharedTagOpsConflictReportInOpenDb'
    | 'readSharedMetadataMigrationDiagnosticsInOpenDb'
    | 'repairSharedMetadataInOpenDb'
    | 'backupsRootPath'
    | 'maintenanceStatePath'
    | 'librarySqlitePath'
    | 'previewSqlitePath'
    | 'kvsSqlitePath'
    | 'eventsSqlitePath'
    | 'hashSqlitePath'
    | 'metricsSqlitePath'
    | 'openLibraryDb'
    | 'openPreviewDb'
    | 'openKvsDb'
    | 'openEventsDb'
    | 'openHashDb'
    | 'openMetricsDb'
    | 'closeLibraryDb'
    | 'closePreviewDb'
    | 'closeCacheDb'
    | 'checkpointOpenCacheDbs'
    | 'getOpenPreviewDb'
    | 'loadLibraryShell'
    | 'localPreviewImageDir'
    | 'rootPreviewImageDir'
    | 'rootCacheDir'
    | 'rootIndexDbPath'
    | 'legacyRootPreviewCacheDir'
    | 'fallbackPreviewImageDir'
    | 'restoreLatestDatabaseBackupForLabel'
    | 'quarantineSqliteFiles'
    | 'recoveryMessage'
    | 'inspectRootIndexSnapshotMaintenance'
    | 'cleanupRootIndexSnapshotMaintenance'
    | 'cacheKeyForRootFile'
    | 'cacheEntryRuntimePath'
    | 'sanitizeCachedFont'
    | 'cachedFontForRuntime'
    | 'ensureRootScanCacheStorage'
    | 'loadLegacyScanCache'
    | 'saveScanCacheFile'
    | 'writeRootCacheManifest'
    | 'openRootIndexDb'
    | 'withRootCacheWriteLock'
    | 'saveRootIndexSqliteChanges'
    | 'upsertFontHashIndex'
    | 'recordCacheEvent'
    | 'invalidateSharedFontRuntimeCaches'
    | 'rootIndexDbDir'
    | 'rootCacheLockDir'
    | 'resolveActiveRootIndexDbPath'
    | 'sqliteQuickCheck'
    | 'hideDirectoryOnWindows'
    | 'initializeRootEventsDb'
    | 'initializeRootHashDb'
    | 'initializeRootMetricsDb'
    | 'rootEventsDbPath'
    | 'rootHashDbPath'
    | 'rootMetricsDbPath'
    | 'openStableSqliteDb'
    | 'initializePreviewDb'
    | 'writeRootPreviewCacheManifest'
    | 'rootPreviewCacheDir'
    | 'rootPreviewDbPath'
    | 'isIgnoredWatcherPath'
  >;
  logging: Pick<Core['logging'],
    | 'appendStartupLog'
  >;
  query: Pick<Data['query'],
    | 'findFontItemInRootIndexes'
    | 'syncMergedIndexForRootSnapshot'
    | 'syncMergedIndexAfterInstallStatusRefresh'
    | 'clearFontQueryCaches'
    | 'syncMergedIndexForRootIncremental'
  >;
  comparison: Pick<Core['comparison'],
    | 'compareFontInstalledWithList'
    | 'buildInstalledFontLookupIndex'
    | 'compareFontInstalledWithLookupIndex'
  >;
  preview: Pick<Data['preview'],
    | 'ensureFontPreviewImageFile'
  >;
  performance: Pick<Core['performance'],
    | 'withGlobalIo'
    | 'isRendererUserActive'
    | 'rendererIdleInMs'
    | 'rendererActivityReason'
    | 'waitForRendererIdle'
    | 'recheckGlobalIoQueues'
    | 'globalIoSnapshot'
  >;
  host: {
    delayToEventLoop: Core['delayToEventLoop'];
    execFileAsync: Core['execFileAsync'];
    nodeRequire: NodeRequire;
  };
  windows: Pick<Core['windows'],
    | 'sendToRendererWindows'
    | 'emitInstallStatusProgress'
    | 'windowsFontsDir'
    | 'currentUserFontsDir'
    | 'createInstallStatusRefreshJobId'
    | 'emitFontIndexProgress'
    | 'createFontScanJobId'
  >;
  paths: Pick<Core['paths'],
    | 'exists'
    | 'dataRoot'
    | 'dataPath'
  >;
  storagePolicy: Pick<Core['storage'],
    | 'storageProfileForPath'
    | 'scanWorkerCount'
  >;
  rustCoreWorkerRuntime: Pick<Core['rustCoreWorkerRuntime'], 'runRustSystemInstalledFonts' | 'runRustInstallStatusCompare' | 'runRustDatabaseHealthCheck' | 'runRustDatabaseBackup' | 'runRustPreviewCacheMaintenance' | 'runRustFontIndexListWorker' | 'runRustFontParseBatch' | 'runRustWatcherPreflight'>;
  assertFeedbackReady: () => void;
  refreshKnownSharedTagsFromMetadata: ReturnType<typeof createSharedKnownTagsRuntime>['refreshKnownSharedTagsFromMetadata'];
}

export function createMainOperationsCompositionRuntime(options: MainOperationsCompositionOptions) {
  const {
    tasksSqlitePath,
    openRecoverableApplicationSqliteDb,
    closeSqliteDb,
    ensureSqliteColumn,
    getOpenLibraryDb,
    getSystemInstalledFontsCached,
    saveInstallStatusIndex,
    appWatchedFolders,
    loadSharedFontsForFolders,
    readInstallStatusIndex,
    readInstalledTotalSummaryForRoots,
    saveInstalledTotalSummaryForRoots,
    rootForFontPath,
    sharedMetadataDbPathForRoot,
    openSharedMetadataDb,
    ensureSharedTagOpsBackfilledInOpenDb,
    ensureSharedTagOpsReplayedInOpenDb,
    readSharedTagOpsDiagnosticsInOpenDb,
    readSharedTagOpsConflictReportInOpenDb,
    readSharedMetadataMigrationDiagnosticsInOpenDb,
    repairSharedMetadataInOpenDb,
    backupsRootPath,
    maintenanceStatePath,
    librarySqlitePath,
    previewSqlitePath,
    kvsSqlitePath,
    eventsSqlitePath,
    hashSqlitePath,
    metricsSqlitePath,
    openLibraryDb,
    openPreviewDb,
    openKvsDb,
    openEventsDb,
    openHashDb,
    openMetricsDb,
    closeLibraryDb,
    closePreviewDb,
    closeCacheDb,
    checkpointOpenCacheDbs,
    getOpenPreviewDb,
    loadLibraryShell,
    localPreviewImageDir,
    rootPreviewImageDir,
    rootCacheDir,
    rootIndexDbPath,
    legacyRootPreviewCacheDir,
    fallbackPreviewImageDir,
    restoreLatestDatabaseBackupForLabel,
    quarantineSqliteFiles,
    recoveryMessage,
    inspectRootIndexSnapshotMaintenance,
    cleanupRootIndexSnapshotMaintenance,
    cacheKeyForRootFile,
    cacheEntryRuntimePath,
    sanitizeCachedFont,
    cachedFontForRuntime,
    ensureRootScanCacheStorage,
    loadLegacyScanCache,
    saveScanCacheFile,
    writeRootCacheManifest,
    openRootIndexDb,
    withRootCacheWriteLock,
    saveRootIndexSqliteChanges,
    upsertFontHashIndex,
    recordCacheEvent,
    invalidateSharedFontRuntimeCaches,
    rootIndexDbDir,
    rootCacheLockDir,
    resolveActiveRootIndexDbPath,
    sqliteQuickCheck,
    hideDirectoryOnWindows,
    initializeRootEventsDb,
    initializeRootHashDb,
    initializeRootMetricsDb,
    rootEventsDbPath,
    rootHashDbPath,
    rootMetricsDbPath,
    openStableSqliteDb,
    initializePreviewDb,
    writeRootPreviewCacheManifest,
    rootPreviewCacheDir,
    rootPreviewDbPath,
    isIgnoredWatcherPath,
  } = options.storage;
  const { appendStartupLog } = options.logging;
  const {
    findFontItemInRootIndexes,
    syncMergedIndexForRootSnapshot,
    syncMergedIndexAfterInstallStatusRefresh,
    clearFontQueryCaches,
    syncMergedIndexForRootIncremental,
  } = options.query;
  const {
    compareFontInstalledWithList,
    buildInstalledFontLookupIndex,
    compareFontInstalledWithLookupIndex,
  } = options.comparison;
  const { ensureFontPreviewImageFile } = options.preview;
  const {
    withGlobalIo,
    isRendererUserActive,
    rendererIdleInMs,
    rendererActivityReason,
    waitForRendererIdle,
    recheckGlobalIoQueues,
    globalIoSnapshot,
  } = options.performance;
  const { delayToEventLoop, execFileAsync, nodeRequire } = options.host;
  const {
    sendToRendererWindows,
    emitInstallStatusProgress,
    windowsFontsDir,
    currentUserFontsDir,
    createInstallStatusRefreshJobId,
    emitFontIndexProgress,
    createFontScanJobId,
  } = options.windows;
  const { exists, dataRoot, dataPath } = options.paths;
  const { storageProfileForPath, scanWorkerCount } = options.storagePolicy;
  const { rustCoreWorkerRuntime, assertFeedbackReady, refreshKnownSharedTagsFromMetadata } = options;

  const backgroundRuntime = createMainBackgroundRuntime({
    tasksSqlitePath,
    openRecoverableApplicationSqliteDb,
    closeSqliteDb,
    ensureSqliteColumn,
    setSqliteMeta,
    getOpenLibraryDb,
    appendStartupLog,
    taskSqliteSchemaVersion: TASKS_SQLITE_SCHEMA_VERSION,
    taskLockStaleMs: TASK_LOCK_STALE_MS,
    safeStartupTaskTypes: SAFE_STARTUP_TASK_TYPES,
    recoverScanTasksOnStartup: STARTUP_RECOVER_SCAN_TASKS_ENABLED,
    completedTaskRetentionMs: COMPLETED_TASK_RETENTION_MS,
    failedTaskRetentionMs: FAILED_TASK_RETENTION_MS,
    taskErrorRetentionMs: TASK_ERROR_RETENTION_MS,
    normalizePathForCacheCompare,
    findFontItemInRootIndexes: (fontId: string, normalizedPath: string) =>
      findFontItemInRootIndexes(fontId, normalizedPath),
    getSystemInstalledFontsCached: (force?: boolean) =>
      getSystemInstalledFontsCached(force),
    compareFontInstalledWithList,
    saveInstallStatusIndex: (
      results: Record<string, InstallCompareResult>,
      itemsById: Map<string, FontItem>,
    ) => saveInstallStatusIndex(results, itemsById),
    ensureFontPreviewImageFile: (
      item: FontItem,
      text: string,
      fontSize: number,
      width: number,
      height: number,
      force: boolean,
      returnDataUrl: boolean,
    ) =>
      ensureFontPreviewImageFile(
        item,
        text,
        fontSize,
        width,
        height,
        force,
        returnDataUrl,
      ),
    withGlobalIo,
    scanFolders: async (folders: string[], knownFonts: FontItem[]) => {
      const result = await scanFolders(folders, knownFonts);
      for (const root of result.folders || []) {
        await syncMergedIndexForRootSnapshot(root, "scan-finished");
        await delayToEventLoop();
      }
      return result;
    },
    runDatabaseMaintenance: (options: { createBackup?: boolean }) =>
      runDatabaseMaintenance(options),
    backgroundTaskSchedulerIntervalMs: BACKGROUND_TASK_SCHEDULER_INTERVAL_MS,
    backgroundTaskSchedulerConcurrency: BACKGROUND_TASK_SCHEDULER_CONCURRENCY,
    backgroundTaskSchedulerBatchSize: BACKGROUND_TASK_SCHEDULER_BATCH_SIZE,
    backgroundTaskSchedulerStartDelayMs: BACKGROUND_TASK_SCHEDULER_START_DELAY_MS,
    sendToRendererWindows,
    isRendererUserActive,
    rendererIdleInMs,
    rendererActivityReason,
  });

  const {
    openTasksDb,
    closeTasksDb,
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
    runBackgroundTaskSchedulerOnce,
    backgroundTaskSchedulerStatus,
    startBackgroundTaskScheduler,
    stopBackgroundTaskScheduler,
  } = backgroundRuntime;

  const {
    readSharedMetadataFrontendDiagnostics,
    repairSharedMetadataFromFrontend,
    runDatabaseHealthCheck,
    createDatabaseBackup,
    restoreLatestApplicationDatabase,
    runDatabaseMaintenance,
    runStartupDatabaseMaintenance,
    readSharedIndexSnapshotFrontendDiagnostics,
    repairSharedIndexSnapshotFromFrontend
  } = createMainMaintenanceCompositionRuntime({
    appWatchedFolders,
    exists,
    sharedMetadataDbPathForRoot,
    openSharedMetadataDb,
    closeSqliteDb,
    ensureSharedTagOpsBackfilledInOpenDb,
    ensureSharedTagOpsReplayedInOpenDb,
    readSharedTagOpsDiagnosticsInOpenDb,
    readSharedTagOpsConflictReportInOpenDb,
    readSharedMetadataMigrationDiagnosticsInOpenDb,
    repairSharedMetadataInOpenDb,
    appendStartupLog,
    backupsRootPath,
    maintenanceStatePath,
    dataRoot,
    librarySqlitePath,
    tasksSqlitePath,
    previewSqlitePath,
    kvsSqlitePath,
    eventsSqlitePath,
    hashSqlitePath,
    metricsSqlitePath,
    openLibraryDb,
    openTasksDb,
    openPreviewDb,
    openKvsDb,
    openEventsDb,
    openHashDb,
    openMetricsDb,
    closeLibraryDb,
    closeTasksDb,
    closePreviewDb,
    closeCacheDb,
    checkpointTasksDb,
    checkpointOpenCacheDbs,
    getOpenLibraryDb,
    getOpenPreviewDb,
    loadLibraryShell,
    localPreviewImageDir,
    rootPreviewImageDir,
    rootCacheDir,
    rootIndexDbPath,
    legacyRootPreviewCacheDir,
    fallbackPreviewImageDir,
    restoreLatestDatabaseBackupForLabel,
    quarantineSqliteFiles,
    recoveryMessage,
    runTaskMaintenance,
    inspectRootIndexSnapshotMaintenance,
    cleanupRootIndexSnapshotMaintenance,
    rustCoreWorkerRuntime,
  });

  const {
    scanFolders,
    scanFoldersManaged,
    cancelActiveFontScan,
    activeFontScanStatus,
    isIndexingActive,
    activeScanJobId,
    refreshWatchedFolder,
    sendFontIndexChanged,
    startWatchingFolders,
    stopFolderWatchers
  } = createMainScanCompositionRuntime({
    dataPath,
    nodeRequire,
    storageProfileForPath,
    scanWorkerCount,
    appendStartupLog,
    emitFontIndexProgress,
    recheckGlobalIoQueues,
    globalIoSnapshot,
    withGlobalIo,
    cacheKeyForRootFile,
    cacheEntryRuntimePath,
    sanitizeCachedFont,
    cachedFontForRuntime,
    ensureRootScanCacheStorage,
    loadLegacyScanCache,
    saveScanCacheFile,
    writeRootCacheManifest,
    openRootIndexDb,
    closeSqliteDb,
    withRootCacheWriteLock,
    saveRootIndexSqliteChanges,
    upsertFontHashIndex,
    recordCacheEvent,
    rustCoreWorkerRuntime,
    invalidateSharedFontRuntimeCaches,
    createFontScanJobId,
    delayToEventLoop,
    rootIndexDbDir,
    rootCacheLockDir,
    rootCacheDir,
    rootIndexDbPath,
    resolveActiveRootIndexDbPath,
    sqliteQuickCheck,
    quarantineSqliteFiles,
    recoveryMessage,
    hideDirectoryOnWindows,
    exists,
    initializeRootEventsDb,
    initializeRootHashDb,
    initializeRootMetricsDb,
    rootEventsDbPath,
    rootHashDbPath,
    rootMetricsDbPath,
    openStableSqliteDb,
    initializePreviewDb,
    writeRootPreviewCacheManifest,
    rootPreviewCacheDir,
    rootPreviewImageDir,
    rootPreviewDbPath,
    appWatchedFolders,
    syncMergedIndexForRootSnapshot,
    syncMergedIndexForRootIncremental,
    isIgnoredWatcherPath,
    closePreviewDb,
    closeTasksDb,
    closeLibraryDb,
    assertFeedbackReady,
  });

  const installStatusRefreshRuntime = createInstallStatusRefreshRuntime({
    appWatchedFolders,
    loadSharedFontsForFolders,
    readInstallStatusIndex,
    saveInstallStatusIndex,
    readInstalledTotalSummaryForRoots,
    saveInstalledTotalSummaryForRoots,
    getSystemInstalledFontsCached,
    runRustSystemInstalledFonts:
      rustCoreWorkerRuntime.runRustSystemInstalledFonts,
    runRustInstallStatusCompare:
      rustCoreWorkerRuntime.runRustInstallStatusCompare,
    appName: APP_NAME,
    buildInstalledFontLookupIndex,
    compareFontInstalledWithLookupIndex,
    rootForFontPath,
    syncMergedIndexAfterInstallStatusRefresh,
    clearFontQueryCaches: () => {
      clearFontQueryCaches();
    },
    emitInstallStatusProgress,
    waitForRendererIdle,
    delayToEventLoop,
    withGlobalIo,
    execFileAsync,
    windowsFontsDir,
    currentUserFontsDir,
    fontExtensions: FONT_EXTENSIONS,
    appendStartupLog,
    installStatusRefreshBatchSize: INSTALL_STATUS_REFRESH_BATCH_SIZE,
    lightweightMissingThreshold: INSTALL_STATUS_LIGHTWEIGHT_MISSING_THRESHOLD,
  });

  const {
    compareFontInstalled,
    compareFontsInstalled,
    refreshInstallStatusIndex,
  } = installStatusRefreshRuntime;

  const installStatusRefreshStarterRuntime =
    createInstallStatusRefreshStarterRuntime({
      createInstallStatusRefreshJobId,
      refreshInstallStatusIndex,
      emitInstallStatusProgress,
      appendLog: appendStartupLog,
    });

  const { startInstallStatusRefreshIndex } =
    installStatusRefreshStarterRuntime;
  let startupTasksScheduled = false;
  function startStartupTasks(): void {
    assertFeedbackReady();
    if (startupTasksScheduled) throw new Error('startup tasks already scheduled');
    startupTasksScheduled = true;
    const sharedKnownTagsStartupRefreshTimer = setTimeout(() => {
      void appWatchedFolders()
        .then((folders) => refreshKnownSharedTagsFromMetadata(folders))
        .catch((error) =>
          appendStartupLog(
            `shared known tags startup refresh skipped: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }, 1500);
    (
      sharedKnownTagsStartupRefreshTimer as ReturnType<typeof setTimeout> & {
        unref?: () => void;
      }
    ).unref?.();
    appendStartupLog(
      "shared known tags startup refresh scheduled: non-blocking delayMs=1500",
    );
  }

  const capabilities: MainOperationsCompositionRuntime['capabilities'] = {
    scanFoldersManaged,
    cancelActiveFontScan,
    activeFontScanStatus,
    startWatchingFolders,
    refreshWatchedFolder: (...args) => { assertFeedbackReady(); return refreshWatchedFolder(...args); },
    readSharedMetadataFrontendDiagnostics,
    repairSharedMetadataFromFrontend,
    readSharedIndexSnapshotFrontendDiagnostics,
    repairSharedIndexSnapshotFromFrontend,
    runDatabaseHealthCheck,
    createDatabaseBackup,
    runDatabaseMaintenance: (...args) => { assertFeedbackReady(); return runDatabaseMaintenance(...args); },
    restoreLatestApplicationDatabase,
    listBackgroundTaskSummaries,
    backgroundTaskSchedulerStatus,
    compareFontInstalled,
    compareFontsInstalled,
    refreshInstallStatusIndex: (...args) => { assertFeedbackReady(); return refreshInstallStatusIndex(...args); },
    runBackgroundTaskSchedulerOnce: () => { assertFeedbackReady(); return runBackgroundTaskSchedulerOnce(); },
    startInstallStatusRefreshIndex: (...args) => { assertFeedbackReady(); return startInstallStatusRefreshIndex(...args); },
    startupDbMaintenanceIdleDelayMs: STARTUP_DB_MAINTENANCE_IDLE_DELAY_MS, startupBackgroundTasksEnabled: STARTUP_BACKGROUND_TASKS_ENABLED
  };
  const lifecycle: MainOperationsCompositionRuntime['lifecycle'] = {
    runStartupDatabaseMaintenance: () => { assertFeedbackReady(); return runStartupDatabaseMaintenance(); },
    startBackgroundTaskScheduler: () => { assertFeedbackReady(); startBackgroundTaskScheduler(); },
    stopBackgroundTaskScheduler,
    stopFolderWatchers
  };
  const resources: MainOperationsCompositionRuntime['resources'] = { closeTasksDb, checkpointTasksDb };
  const feedback: MainOperationsFeedback = {
    isIndexingActive,
    activeScanJobId,
    isInstallStatusRefreshActive: () => Boolean(installStatusRefreshStarterRuntime.activeInstallStatusRefreshJob()),
    activeBackgroundTaskCount: () => backgroundRuntime.schedulerRuntime.activeCount(),
    refreshWatchedFolder,
    sendFontIndexChanged,
    previewTaskKey,
    completeBackgroundTask,
    skipBackgroundTask,
    upsertBackgroundTask,
    startBackgroundTask,
    heartbeatBackgroundTask,
    failBackgroundTask
  };
  return { capabilities, lifecycle, resources, feedback, startStartupTasks };
}
