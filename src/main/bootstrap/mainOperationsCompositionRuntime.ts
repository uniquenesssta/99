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
  tasksSqlitePath: Data['storage']['tasksSqlitePath'];
  openRecoverableApplicationSqliteDb: Data['storage']['openRecoverableApplicationSqliteDb'];
  closeSqliteDb: Data['storage']['closeSqliteDb'];
  ensureSqliteColumn: Data['storage']['ensureSqliteColumn'];
  getOpenLibraryDb: Data['storage']['getOpenLibraryDb'];
  appendStartupLog: Core['logging']['appendStartupLog'];
  findFontItemInRootIndexes: Data['query']['findFontItemInRootIndexes'];
  getSystemInstalledFontsCached: Data['storage']['getSystemInstalledFontsCached'];
  compareFontInstalledWithList: Core['comparison']['compareFontInstalledWithList'];
  saveInstallStatusIndex: Data['storage']['saveInstallStatusIndex'];
  ensureFontPreviewImageFile: Data['preview']['ensureFontPreviewImageFile'];
  withGlobalIo: Core['performance']['withGlobalIo'];
  syncMergedIndexForRootSnapshot: Data['query']['syncMergedIndexForRootSnapshot'];
  delayToEventLoop: Core['delayToEventLoop'];
  sendToRendererWindows: Core['windows']['sendToRendererWindows'];
  isRendererUserActive: Core['performance']['isRendererUserActive'];
  rendererIdleInMs: Core['performance']['rendererIdleInMs'];
  rendererActivityReason: Core['performance']['rendererActivityReason'];
  appWatchedFolders: Data['storage']['appWatchedFolders'];
  loadSharedFontsForFolders: Data['storage']['loadSharedFontsForFolders'];
  readInstallStatusIndex: Data['storage']['readInstallStatusIndex'];
  readInstalledTotalSummaryForRoots: Data['storage']['readInstalledTotalSummaryForRoots'];
  saveInstalledTotalSummaryForRoots: Data['storage']['saveInstalledTotalSummaryForRoots'];
  rustCoreWorkerRuntime: Pick<Core['rustCoreWorkerRuntime'], 'runRustSystemInstalledFonts' | 'runRustInstallStatusCompare' | 'runRustDatabaseHealthCheck' | 'runRustDatabaseBackup' | 'runRustPreviewCacheMaintenance' | 'runRustFontIndexListWorker' | 'runRustFontParseBatch' | 'runRustWatcherPreflight'>;
  buildInstalledFontLookupIndex: Core['comparison']['buildInstalledFontLookupIndex'];
  compareFontInstalledWithLookupIndex: Core['comparison']['compareFontInstalledWithLookupIndex'];
  rootForFontPath: Data['storage']['rootForFontPath'];
  syncMergedIndexAfterInstallStatusRefresh: Data['query']['syncMergedIndexAfterInstallStatusRefresh'];
  clearFontQueryCaches: Data['query']['clearFontQueryCaches'];
  emitInstallStatusProgress: Core['windows']['emitInstallStatusProgress'];
  waitForRendererIdle: Core['performance']['waitForRendererIdle'];
  execFileAsync: Core['execFileAsync'];
  windowsFontsDir: Core['windows']['windowsFontsDir'];
  currentUserFontsDir: Core['windows']['currentUserFontsDir'];
  createInstallStatusRefreshJobId: Core['windows']['createInstallStatusRefreshJobId'];
  assertFeedbackReady: () => void;
  refreshKnownSharedTagsFromMetadata: ReturnType<typeof createSharedKnownTagsRuntime>['refreshKnownSharedTagsFromMetadata'];
  exists: Core['paths']['exists'];
  sharedMetadataDbPathForRoot: Data['storage']['sharedMetadataDbPathForRoot'];
  openSharedMetadataDb: Data['storage']['openSharedMetadataDb'];
  ensureSharedTagOpsBackfilledInOpenDb: Data['storage']['ensureSharedTagOpsBackfilledInOpenDb'];
  ensureSharedTagOpsReplayedInOpenDb: Data['storage']['ensureSharedTagOpsReplayedInOpenDb'];
  readSharedTagOpsDiagnosticsInOpenDb: Data['storage']['readSharedTagOpsDiagnosticsInOpenDb'];
  readSharedTagOpsConflictReportInOpenDb: Data['storage']['readSharedTagOpsConflictReportInOpenDb'];
  readSharedMetadataMigrationDiagnosticsInOpenDb: Data['storage']['readSharedMetadataMigrationDiagnosticsInOpenDb'];
  repairSharedMetadataInOpenDb: Data['storage']['repairSharedMetadataInOpenDb'];
  backupsRootPath: Data['storage']['backupsRootPath'];
  maintenanceStatePath: Data['storage']['maintenanceStatePath'];
  dataRoot: Core['paths']['dataRoot'];
  librarySqlitePath: Data['storage']['librarySqlitePath'];
  previewSqlitePath: Data['storage']['previewSqlitePath'];
  kvsSqlitePath: Data['storage']['kvsSqlitePath'];
  eventsSqlitePath: Data['storage']['eventsSqlitePath'];
  hashSqlitePath: Data['storage']['hashSqlitePath'];
  metricsSqlitePath: Data['storage']['metricsSqlitePath'];
  openLibraryDb: Data['storage']['openLibraryDb'];
  openPreviewDb: Data['storage']['openPreviewDb'];
  openKvsDb: Data['storage']['openKvsDb'];
  openEventsDb: Data['storage']['openEventsDb'];
  openHashDb: Data['storage']['openHashDb'];
  openMetricsDb: Data['storage']['openMetricsDb'];
  closeLibraryDb: Data['storage']['closeLibraryDb'];
  closePreviewDb: Data['storage']['closePreviewDb'];
  closeCacheDb: Data['storage']['closeCacheDb'];
  checkpointOpenCacheDbs: Data['storage']['checkpointOpenCacheDbs'];
  getOpenPreviewDb: Data['storage']['getOpenPreviewDb'];
  loadLibraryShell: Data['storage']['loadLibraryShell'];
  localPreviewImageDir: Data['storage']['localPreviewImageDir'];
  rootPreviewImageDir: Data['storage']['rootPreviewImageDir'];
  rootCacheDir: Data['storage']['rootCacheDir'];
  rootIndexDbPath: Data['storage']['rootIndexDbPath'];
  legacyRootPreviewCacheDir: Data['storage']['legacyRootPreviewCacheDir'];
  fallbackPreviewImageDir: Data['storage']['fallbackPreviewImageDir'];
  restoreLatestDatabaseBackupForLabel: Data['storage']['restoreLatestDatabaseBackupForLabel'];
  quarantineSqliteFiles: Data['storage']['quarantineSqliteFiles'];
  recoveryMessage: Data['storage']['recoveryMessage'];
  inspectRootIndexSnapshotMaintenance: Data['storage']['inspectRootIndexSnapshotMaintenance'];
  cleanupRootIndexSnapshotMaintenance: Data['storage']['cleanupRootIndexSnapshotMaintenance'];
  dataPath: Core['paths']['dataPath'];
  nodeRequire: NodeRequire;
  storageProfileForPath: Core['storage']['storageProfileForPath'];
  scanWorkerCount: Core['storage']['scanWorkerCount'];
  emitFontIndexProgress: Core['windows']['emitFontIndexProgress'];
  recheckGlobalIoQueues: Core['performance']['recheckGlobalIoQueues'];
  globalIoSnapshot: Core['performance']['globalIoSnapshot'];
  cacheKeyForRootFile: Data['storage']['cacheKeyForRootFile'];
  cacheEntryRuntimePath: Data['storage']['cacheEntryRuntimePath'];
  sanitizeCachedFont: Data['storage']['sanitizeCachedFont'];
  cachedFontForRuntime: Data['storage']['cachedFontForRuntime'];
  ensureRootScanCacheStorage: Data['storage']['ensureRootScanCacheStorage'];
  loadLegacyScanCache: Data['storage']['loadLegacyScanCache'];
  saveScanCacheFile: Data['storage']['saveScanCacheFile'];
  writeRootCacheManifest: Data['storage']['writeRootCacheManifest'];
  openRootIndexDb: Data['storage']['openRootIndexDb'];
  withRootCacheWriteLock: Data['storage']['withRootCacheWriteLock'];
  saveRootIndexSqliteChanges: Data['storage']['saveRootIndexSqliteChanges'];
  upsertFontHashIndex: Data['storage']['upsertFontHashIndex'];
  recordCacheEvent: Data['storage']['recordCacheEvent'];
  invalidateSharedFontRuntimeCaches: Data['storage']['invalidateSharedFontRuntimeCaches'];
  createFontScanJobId: Core['windows']['createFontScanJobId'];
  rootIndexDbDir: Data['storage']['rootIndexDbDir'];
  rootCacheLockDir: Data['storage']['rootCacheLockDir'];
  resolveActiveRootIndexDbPath: Data['storage']['resolveActiveRootIndexDbPath'];
  sqliteQuickCheck: Data['storage']['sqliteQuickCheck'];
  hideDirectoryOnWindows: Data['storage']['hideDirectoryOnWindows'];
  initializeRootEventsDb: Data['storage']['initializeRootEventsDb'];
  initializeRootHashDb: Data['storage']['initializeRootHashDb'];
  initializeRootMetricsDb: Data['storage']['initializeRootMetricsDb'];
  rootEventsDbPath: Data['storage']['rootEventsDbPath'];
  rootHashDbPath: Data['storage']['rootHashDbPath'];
  rootMetricsDbPath: Data['storage']['rootMetricsDbPath'];
  openStableSqliteDb: Data['storage']['openStableSqliteDb'];
  initializePreviewDb: Data['storage']['initializePreviewDb'];
  writeRootPreviewCacheManifest: Data['storage']['writeRootPreviewCacheManifest'];
  rootPreviewCacheDir: Data['storage']['rootPreviewCacheDir'];
  rootPreviewDbPath: Data['storage']['rootPreviewDbPath'];
  syncMergedIndexForRootIncremental: Data['query']['syncMergedIndexForRootIncremental'];
  isIgnoredWatcherPath: Data['storage']['isIgnoredWatcherPath'];
}

export function createMainOperationsCompositionRuntime(options: MainOperationsCompositionOptions) {
  const {
    tasksSqlitePath,
    openRecoverableApplicationSqliteDb,
    closeSqliteDb,
    ensureSqliteColumn,
    getOpenLibraryDb,
    appendStartupLog,
    findFontItemInRootIndexes,
    getSystemInstalledFontsCached,
    compareFontInstalledWithList,
    saveInstallStatusIndex,
    ensureFontPreviewImageFile,
    withGlobalIo,
    syncMergedIndexForRootSnapshot,
    delayToEventLoop,
    sendToRendererWindows,
    isRendererUserActive,
    rendererIdleInMs,
    rendererActivityReason,
    appWatchedFolders,
    loadSharedFontsForFolders,
    readInstallStatusIndex,
    readInstalledTotalSummaryForRoots,
    saveInstalledTotalSummaryForRoots,
    rustCoreWorkerRuntime,
    buildInstalledFontLookupIndex,
    compareFontInstalledWithLookupIndex,
    rootForFontPath,
    syncMergedIndexAfterInstallStatusRefresh,
    clearFontQueryCaches,
    emitInstallStatusProgress,
    waitForRendererIdle,
    execFileAsync,
    windowsFontsDir,
    currentUserFontsDir,
    createInstallStatusRefreshJobId,
    assertFeedbackReady,
    refreshKnownSharedTagsFromMetadata,
    exists,
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
    dataRoot,
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
    dataPath,
    nodeRequire,
    storageProfileForPath,
    scanWorkerCount,
    emitFontIndexProgress,
    recheckGlobalIoQueues,
    globalIoSnapshot,
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
    createFontScanJobId,
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
    syncMergedIndexForRootIncremental,
    isIgnoredWatcherPath,
  } = options;

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
