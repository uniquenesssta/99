import { createRequire } from "node:module";
import type { FontIndexChangePayload, FontItem, FontTagBatchItem, FontTagUpdateResult, InstallCompareResult } from "../shared/types";
import { createFontActivationRuntime } from "./activation/fontActivationRuntime";
import { createMainActivationInstallStatusSaveRuntime } from "./activation/mainActivationInstallStatusSaveRuntime";
import { registerMainProcessRuntime } from "./app/mainProcessRuntimeRegistration";
import { FONT_EXTENSIONS } from "./bootstrap/mainIndexConstants";
import { createMainRuntimeRegistrationPayload } from "./bootstrap/mainRuntimeRegistrationPayload";
import { fileCacheSignature, isRootIndexDbPath } from "./cache/cachePaths";
import {
  CACHE_ARCHITECTURE_VERSION,
  MAINTENANCE_SQLITE_SCHEMA_VERSION,
  PREVIEW_SQLITE_SCHEMA_VERSION,
  TASKS_SQLITE_SCHEMA_VERSION,
} from "./cache/constants";
import { setSqliteMeta, sqliteTableExists } from "./db/sqliteHelpers";

import { createPhysicalFolderActions, pathInsideFolder } from "./folders/physicalFolders";
import { createFontMoveTransactionRuntime } from "./folders/fontMoveTransactionRuntime";
import { fontItemFromPath, hasValidFontSignature, sha1 } from "./fonts/fontRuntime";
import { createFontScanWorkers } from "./indexing/fontScanWorkers";
import { createSharedMetadataFrontendDiagnosticsRuntime } from "./indexing/shared-metadata/sharedMetadataFrontendDiagnosticsRuntime";
import { createScanOrchestrator, type ScanOrchestratorRuntime } from "./indexing/scanOrchestrator";
import { indexListWorkerSource, scanWorkerSource } from "./indexing/workerSources";
import { createCurrentUserManagedInstallRuntime } from "./install/currentUserManagedInstallRuntime";
import { createManagedFontOwnershipRuntime } from "./install/managedFontOwnershipRuntime";
import { createInstallStatusRefreshRuntime } from "./install/installStatusRefreshRuntime";
import {
  createInstallStatusRefreshStarterRuntime,
  type InstallStatusRefreshStarterRuntime,
} from "./install/installStatusRefreshStarterRuntime";
import { createSystemFontInstallRuntime } from "./install/systemFontInstallRuntime";
import { isCleanWindowsDefaultCandidate, isCleanWindowsDefaultFontName, isCleanWindowsDefaultItem } from "./install/windowsDefaultFonts";
import { createSharedFontMetadataMutations } from "./library/sharedFontMetadataMutations";
import { createSharedKnownTagsRuntime } from "./library/sharedKnownTagsRuntime";
import { createSharedMetadataMergedIndexSyncRuntime } from "./library/sharedMetadataMergedIndexSyncRuntime";
import { createTagMetadataRevisionBarrierRuntime } from "./library/tagMetadataRevisionBarrierRuntime";
import { createTagMutationStateSignalRuntime } from "./library/tagMutationStateSignalRuntime";
import { createTagMutationWriteProtocolRuntime } from "./library/tagMutationWriteProtocolRuntime";
import { createApplicationDatabaseMaintenanceRuntime } from "./maintenance/applicationDatabaseMaintenanceRuntime";
import { createSharedIndexSnapshotFrontendRuntime } from "./maintenance/sharedIndexSnapshotFrontendRuntime";
import { normalizePathForCacheCompare } from "./path/cachePath";
import { findBestWatchedRootForFile, isPathInsideAnyRoot, normalizeWatchedFontFolders, uniqueResolvedFolders } from "./path/fontPathPolicy";
import { createMainBackgroundRuntime } from "./tasks/mainBackgroundRuntimeBootstrap";
import type { MainBackgroundTaskSchedulerRuntime } from "./tasks/mainBackgroundTaskSchedulerRuntime";
import { createFolderWatcherRuntime } from "./watcher/folderWatcherRuntime";
import { createManualFolderRefreshRuntime } from "./watcher/manualFolderRefreshRuntime";
import { createWatchedFolderIndexRuntime } from "./watcher/watchedFolderIndexRuntime";
import {
  APP_ID,
  APP_NAME,
  BUILD_MARKER,
  AUTO_DATABASE_BACKUP_INTERVAL_MS,
  BACKGROUND_TASK_SCHEDULER_BATCH_SIZE,
  BACKGROUND_TASK_SCHEDULER_CONCURRENCY,
  BACKGROUND_TASK_SCHEDULER_INTERVAL_MS,
  BACKGROUND_TASK_SCHEDULER_START_DELAY_MS,
  COMPLETED_TASK_RETENTION_MS,
  CPU_COUNT,
  LOG_SCHEMA_VERSION,
  DATABASE_BACKUP_RETENTION_COUNT,
  FAILED_TASK_RETENTION_MS,
  FONT_SCAN_CACHE_VERSION,
  INDEX_PROGRESS_EVENT_MIN_INTERVAL_MS,
  INSTALL_STATUS_LIGHTWEIGHT_MISSING_THRESHOLD,
  INSTALL_STATUS_REFRESH_BATCH_SIZE,
  LOCAL_SCAN_WORKERS,
  NETWORK_SCAN_WORKERS,
  PREVIEW_OK_RETENTION_MS,
  SAFE_STARTUP_TASK_TYPES,
  SCAN_HASH_FLUSH_BATCH_SIZE,
  SCAN_STAT_CONCURRENCY,
  SCAN_WORKER_BATCH_SIZE,
  SCAN_WORKER_VERSION,
  SCRIPT_DETECTION_VERSION,
  STARTUP_BACKGROUND_TASKS_ENABLED,
  STARTUP_DB_MAINTENANCE_IDLE_DELAY_MS,
  STARTUP_RECOVER_SCAN_TASKS_ENABLED,
  TASK_ERROR_RETENTION_MS,
  TASK_LOCK_STALE_MS,
  VERBOSE_RENDERER_LOGS,
  WATCHER_FLUSH_DEBOUNCE_MS,
  WATCHER_STARTUP_GRACE_MS,
  WINDOWS_STORAGE_MEDIA_DETECT_ENABLED,
} from "./app/appRuntimeConfig";
import { createMainCoreCompositionRuntime } from './bootstrap/mainCoreCompositionRuntime';
import { createMainDataCompositionRuntime } from './bootstrap/mainDataCompositionRuntime';
const nodeRequire = createRequire(import.meta.url);

const coreComposition = createMainCoreCompositionRuntime({
  isIndexingActive: () => Boolean(scanOrchestratorRuntime?.isActive()),
  activeScanJobId: () => scanOrchestratorRuntime?.activeJobId() || "",
  isInstallStatusRefreshActive: () => Boolean(installStatusRefreshStarterRuntimeRef?.activeInstallStatusRefreshJob()),
  activeBackgroundTaskCount: () => backgroundTaskSchedulerRuntimeRef?.activeCount() || 0,
  onDaemonDomainEvent: (event) => tagMutationStateSignalRuntime.handleRustCoreDaemonDomainEvent(event),
  loadWatchedFontRoots: () => appWatchedFolders(),
  isMainProcessIndexedFont: (identity) => mainProcessFontIndexContains(identity),
});
const { execFileAsync, delayToEventLoop, migrationDiagnosticsRuntime, rustCoreWorkerRuntime } = coreComposition;
const { dataRoot, dataPath, exists } = coreComposition.paths;
const { appendStartupLog, logPath, flushStartupLogAsync, flushStartupLogSync } = coreComposition.logging;
const {
  safeManagedFontName,
  registryNameFor,
  safeTemporaryActiveFontName,
  temporaryActiveRegistryNameFor,
  normalizeCompareText,
  isUsableInstalledNameCandidate,
  isTemporaryActiveInstalledRecord,
  buildInstalledFontLookupIndex,
  compareFontInstalledWithLookupIndex,
  isPathInWindowsFonts,
  isSystemInstalledRecord,
  isCleanWindowsDefaultCompareResult,
  compareFontInstalledWithList,
} = coreComposition.comparison;
const {
  markRendererUserActivity,
  reportRendererLongTask,
  reportPerformanceEvent,
  isRendererUserActive,
  rendererIdleInMs,
  waitForRendererIdle,
  rendererActivityReason,
  recheckGlobalIoQueues,
  globalIoSnapshot,
  withGlobalIo,
  ioLaneSummary,
  startPerformanceLogSampler,
  stopPerformanceLogSampler,
  flushPerformanceLogs,
} = coreComposition.performance;
const {
  showExistingWindow,
  registerFontProtocol,
  createWindow,
  requestRendererWindowsCloseForQuit,
  sendToRendererWindows,
  createFontScanJobId,
  emitFontIndexProgress,
  createInstallStatusRefreshJobId,
  emitInstallStatusProgress,
  ensureWindows,
  currentUserFontsDir,
  windowsFontsDir,
  resolveExistingFontFilePath,
  authorizeFontRead,
  authorizePhysicalFolderParent,
  authorizePhysicalFolderRename,
  authorizeFontMoveSource,
  authorizeFontMoveTarget,
  authorizeFontMoveDestination,
  authorizeManagedFontDelete,
  missingFontPreviewDataUri,
  loadTemporaryActiveFonts,
  saveTemporaryActiveFonts,
  addFontResourceSessionBatch,
  removeFontResourceSessionBatch,
  writeFontRegistryValuesHKCUBatch,
  deleteFontRegistryValuesHKCUBatch,
  addFontResourceSession,
  removeFontResourceSession,
  deleteRegistryValueHKCU,
  requestFontRefresh,
  broadcastFontChange,
  scheduleBackgroundFontRefreshTail,
  advancedFontRefresh,
} = coreComposition.windows;
const { storageProfileForPath, scanWorkerCount } = coreComposition.storage;
const { beginStartupSessionSync, markCleanShutdownSync, ensureDataRootSync, migrateLegacyUserDataIfNeeded } = coreComposition.lifecycle;
const { dataRootErrorMessage } = coreComposition.capabilities;

const tagMetadataRevisionBarrier = createTagMetadataRevisionBarrierRuntime({
  appendStartupLog,
});

const tagMutationStateSignalRuntime = createTagMutationStateSignalRuntime({
  tagMetadataRevisionBarrier,
  clearFontQueryCaches: () => clearFontQueryCaches(),
  appendStartupLog,
});

const tagMutationWriteProtocolRuntime = createTagMutationWriteProtocolRuntime({
  tagMetadataRevisionBarrier,
  clearFontQueryCaches: () => clearFontQueryCaches(),
  appendStartupLog,
});

let backgroundTaskSchedulerRuntimeRef: MainBackgroundTaskSchedulerRuntime | null =
  null;

let installStatusRefreshStarterRuntimeRef: InstallStatusRefreshStarterRuntime | null =
  null;

let scanOrchestratorRuntime: ScanOrchestratorRuntime | null = null;

function scanFoldersRuntime(): ScanOrchestratorRuntime {
  if (!scanOrchestratorRuntime)
    throw new Error("scan orchestrator runtime is not initialized");
  return scanOrchestratorRuntime;
}

const dataComposition = createMainDataCompositionRuntime({
  execFileAsync,
  windowsFontsDir,
  currentUserFontsDir,
  resolveExistingFontFilePath,
  rustCoreWorkerRuntime,
  normalizeCompareText,
  isUsableInstalledNameCandidate,
  withGlobalIo,
  delayToEventLoop,
  appendStartupLog,
  dataPath,
  nodeRequire,
  exists,
  tagMutationStateSignalRuntime,
  dataRoot,
  isCleanWindowsDefaultCompareResult,
  completeBackgroundTask: (key, message) => completeBackgroundTask(key, message),
  isSystemInstalledRecord,
  isPathInWindowsFonts,
  tagMetadataRevisionBarrier,
  migrationDiagnosticsRuntime,
  ensureWindows,
  authorizeFontRead,
  previewTaskKey: (key) => previewTaskKey(key),
  skipBackgroundTask: (key, message) => skipBackgroundTask(key, message),
  upsertBackgroundTask: (key, name, priority, data, status, message, taskOptions) => upsertBackgroundTask(key, name, priority, data, status, message, taskOptions),
  startBackgroundTask: (key, workerId) => startBackgroundTask(key, workerId),
  heartbeatBackgroundTask: (key, progress, message) => heartbeatBackgroundTask(key, progress, message),
  failBackgroundTask: (key, message, stack) => failBackgroundTask(key, message, stack),
  missingFontPreviewDataUri,
  listPhysicalFolderTree: (folders) => listPhysicalFolderTree(folders),
});
const {
  clearInstalledFontsMemoryCache,
  getSystemInstalledFonts,
  getSystemInstalledFontsCached,
  scanSystemInstalledFonts,
  rootCacheDir,
  rootIndexDbDir,
  rootIndexDbPath,
  rootEventsDbPath,
  rootHashDbPath,
  rootMetricsDbPath,
  rootCacheLockDir,
  rootPreviewCacheDir,
  legacyRootPreviewCacheDir,
  rootPreviewImageDir,
  rootPreviewDbPath,
  fallbackPreviewImageDir,
  localPreviewImageDir,
  cacheKeyForRootFile,
  isIgnoredWatcherPath,
  sanitizeCachedFont,
  cachedFontForRuntime,
  cacheEntryRuntimePath,
  librarySqlitePath,
  tasksSqlitePath,
  previewSqlitePath,
  kvsSqlitePath,
  eventsSqlitePath,
  hashSqlitePath,
  metricsSqlitePath,
  backupsRootPath,
  maintenanceStatePath,
  closeSqliteDb,
  recoveryMessage,
  sqliteQuickCheck,
  openStableSqliteDb,
  quarantineSqliteFiles,
  restoreLatestDatabaseBackupForLabel,
  openRecoverableApplicationSqliteDb,
  updateSharedFontMetadataEntries,
  renameSharedTagInMetadataIndexes,
  removeSharedTagFromMetadataIndexes,
  sharedMetadataDbPathForRoot,
  openSharedMetadataDb,
  ensureSharedTagOpsBackfilledInOpenDb,
  ensureSharedTagOpsReplayedInOpenDb,
  readSharedTagOpsDiagnosticsInOpenDb,
  readSharedTagOpsConflictReportInOpenDb,
  readSharedMetadataMigrationDiagnosticsInOpenDb,
  repairSharedMetadataInOpenDb,
  initializeRootEventsDb,
  initializeRootHashDb,
  initializeRootMetricsDb,
  initializePreviewDb,
  openPreviewDb,
  getOpenPreviewDb,
  closePreviewDb,
  openLibraryDb,
  getOpenLibraryDb,
  closeLibraryDb,
  loadLibraryShellFromSqlite,
  setLocalFontTagsBase,
  setLocalFontTagsBatchBase,
  deleteLocalFontTagBase,
  loadLibrary,
  loadLibraryShell,
  saveLibrary,
  openKvsDb,
  setCacheKvs,
  openEventsDb,
  recordCacheEvent,
  openHashDb,
  upsertFontHashIndex,
  openMetricsDb,
  cacheArchitectureInfo,
  initializeCacheArchitectureV2,
  checkpointOpenCacheDbs,
  closeCacheDb,
  rootForFontPath,
  saveInstalledTotalSummaryForRoots,
  readInstalledTotalSummaryForRoots,
  readInstallStatusIndex,
  getInstallStatusIndexSnapshot,
  saveInstallStatusIndex,
  openRootIndexDb,
  saveRootIndexSqliteChanges,
  writeRootCacheManifest,
  withRootCacheWriteLock,
  resolveActiveRootIndexDbPath,
  inspectRootIndexSnapshotMaintenance,
  cleanupRootIndexSnapshotMaintenance,
  loadLegacyScanCache,
  hideDirectoryOnWindows,
  writeRootPreviewCacheManifest,
  ensureRootScanCacheStorage,
  saveScanCacheFile,
  getCacheStats,
  clearScanCache,
  clearPreviewCache,
  ensureSqliteColumn,
  loadFolderCache,
  invalidateSharedFontRuntimeCaches,
  loadSharedFontsForFolders,
  appWatchedFolders,
} = dataComposition.storage;
const {
  queryFontPageInLibrary,
  clearFontQueryCaches,
  searchFontsInLibrary,
  syncMergedIndexAfterInstallStatusRefresh,
  syncMergedIndexForRootIncremental,
  syncMergedIndexForRootSnapshot,
  findFontItemInRootIndexes,
  mainProcessFontIndexContains,
  queryFontsInLibrary,
  getFontMetricsFromLibrary,
} = dataComposition.query;
const {
  getPreviewCacheStatus,
  ensureFontPreviewImageFile,
  readPreviewFontData,
  renderFontPreviewImage,
  readCachedFontPreviewImage,
  readCachedFontPreviewImages,
  ensureFontPreviewCache,
} = dataComposition.preview;

const sharedMetadataFrontendDiagnosticsRuntime =
  createSharedMetadataFrontendDiagnosticsRuntime({
    appWatchedFolders,
    uniqueResolvedFolders,
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
  });

const {
  readSharedMetadataFrontendDiagnostics,
  repairSharedMetadataFromFrontend,
} = sharedMetadataFrontendDiagnosticsRuntime;

async function setLocalFontTags(
  item: FontItem,
  tagNames: string[],
): Promise<FontTagUpdateResult> {
  return tagMutationWriteProtocolRuntime.run({
    scope: "local",
    mutationKind: "local-tags-set",
    inputIds: [item?.id],
    action: () => setLocalFontTagsBase(item, tagNames),
    afterCommit: () => invalidateSharedFontRuntimeCaches(),
  });
}

async function setLocalFontTagsBatch(
  items: FontTagBatchItem[],
): Promise<FontTagUpdateResult> {
  return tagMutationWriteProtocolRuntime.run({
    scope: "local",
    mutationKind: "local-tags-batch-set",
    inputIds: (items || []).map((entry) => entry?.item?.id),
    action: () => setLocalFontTagsBatchBase(items || []),
    afterCommit: () => invalidateSharedFontRuntimeCaches(),
  });
}

async function deleteLocalFontTag(
  tagName: string,
): Promise<FontTagUpdateResult> {
  const cleanTag = String(tagName || "").trim();
  return tagMutationWriteProtocolRuntime.run({
    scope: "local",
    mutationKind: `local-tag-delete:${cleanTag}`,
    action: () => deleteLocalFontTagBase(tagName),
    afterCommit: () => invalidateSharedFontRuntimeCaches(),
  });
}

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
    const result = await scanFoldersRuntime().scanFolders(folders, knownFonts);
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

backgroundTaskSchedulerRuntimeRef = backgroundRuntime.schedulerRuntime;

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
  scheduleActivationInstallStatusSave,
  flushActivationInstallStatusSave,
  hasPendingActivationInstallStatusSave,
  hasInFlightActivationInstallStatusSave,
} = createMainActivationInstallStatusSaveRuntime({
    saveInstallStatusIndex,
    appWatchedFolders,
    rootForFontPath,
    syncMergedIndexAfterInstallStatusRefresh: (folders) =>
      syncMergedIndexAfterInstallStatusRefresh(folders),
    clearFontQueryCaches,
    appendStartupLog,
  });

const databaseMaintenanceRuntime = createApplicationDatabaseMaintenanceRuntime({
  appName: APP_NAME,
  maintenanceSqliteSchemaVersion: MAINTENANCE_SQLITE_SCHEMA_VERSION,
  databaseBackupRetentionCount: DATABASE_BACKUP_RETENTION_COUNT,
  autoDatabaseBackupIntervalMs: AUTO_DATABASE_BACKUP_INTERVAL_MS,
  previewOkRetentionMs: PREVIEW_OK_RETENTION_MS,
  previewSqliteSchemaVersion: PREVIEW_SQLITE_SCHEMA_VERSION,
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
  exists,
  appendStartupLog,
  normalizePathForCacheCompare,
  runTaskMaintenance,
  inspectRootIndexSnapshotMaintenance,
  cleanupRootIndexSnapshotMaintenance,
  runRustDatabaseHealthCheck: rustCoreWorkerRuntime.runRustDatabaseHealthCheck,
  runRustDatabaseBackup: rustCoreWorkerRuntime.runRustDatabaseBackup,
  runRustPreviewCacheMaintenance:
    rustCoreWorkerRuntime.runRustPreviewCacheMaintenance,
});

const {
  runDatabaseHealthCheck,
  createDatabaseBackup,
  restoreLatestApplicationDatabase,
  runDatabaseMaintenance,
  runStartupDatabaseMaintenance,
} = databaseMaintenanceRuntime;

const {
  readSharedIndexSnapshotFrontendDiagnostics,
  repairSharedIndexSnapshotFromFrontend,
} = createSharedIndexSnapshotFrontendRuntime({
  loadLibraryShell,
  rootCacheDir,
  rootIndexDbPath,
  inspectRootIndexSnapshotMaintenance,
  cleanupRootIndexSnapshotMaintenance,
  appendStartupLog,
});

const { runFontIndexListWorker, runFontParseWorkerPool } =
  createFontScanWorkers({
    dataPath,
    scanWorkerVersion: SCAN_WORKER_VERSION,
    scanWorkerBatchSize: SCAN_WORKER_BATCH_SIZE,
    fontExtensions: FONT_EXTENSIONS,
    indexListWorkerSource,
    scanWorkerSource,
    fontkitPath: () => nodeRequire.resolve("fontkit"),
    storageProfileForPath,
    scanWorkerCount,
    appendStartupLog,
  });

scanOrchestratorRuntime = createScanOrchestrator({
  appendStartupLog,
  emitFontIndexProgress,
  sendFontIndexChanged: (payload: FontIndexChangePayload) => sendFontIndexChanged(payload),
  recheckGlobalIoQueues,
  globalIoSnapshot,
  withGlobalIo,
  fontExtensions: FONT_EXTENSIONS,
  scriptDetectionVersion: SCRIPT_DETECTION_VERSION,
  fontScanCacheVersion: FONT_SCAN_CACHE_VERSION,
  scanHashFlushBatchSize: SCAN_HASH_FLUSH_BATCH_SIZE,
  indexProgressEventMinIntervalMs: INDEX_PROGRESS_EVENT_MIN_INTERVAL_MS,
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
  runRustFontIndexListWorker: rustCoreWorkerRuntime.runRustFontIndexListWorker,
  runRustFontParseBatch: rustCoreWorkerRuntime.runRustFontParseBatch,
  runFontIndexListWorker,
  runFontParseWorkerPool,
  scanWorkerCount,
});

let sendFontIndexChanged: (payload: FontIndexChangePayload) => void = () =>
  undefined;

const manualFolderRefreshRuntime = createManualFolderRefreshRuntime({
  fontExtensions: FONT_EXTENSIONS,
  scriptDetectionVersion: SCRIPT_DETECTION_VERSION,
  fontScanCacheVersion: FONT_SCAN_CACHE_VERSION,
  appendStartupLog,
  storageProfileForPath,
  withGlobalIo,
  fileCacheSignature,
  cacheKeyForRootFile,
  cacheEntryRuntimePath,
  hasValidFontSignature,
  fontItemFromPath,
  sanitizeCachedFont,
  cachedFontForRuntime,
  ensureRootScanCacheStorage,
  saveRootIndexSqliteChanges,
  saveScanCacheFile,
  writeRootCacheManifest,
  runFontParseWorkerPool,
  runRustFontIndexListWorker: rustCoreWorkerRuntime.runRustFontIndexListWorker,
  runRustFontParseBatch: rustCoreWorkerRuntime.runRustFontParseBatch,
  scanWorkerCount,
  invalidateSharedFontRuntimeCaches,
  emitFontIndexProgress,
  createFontScanJobId,
  delayToEventLoop,
  rootIndexDbDir,
  rootCacheLockDir,
  rootCacheDir,
  rootIndexDbPath,
  resolveActiveRootIndexDbPath,
  openRootIndexDb,
  closeSqliteDb,
  sqliteQuickCheck,
  sqliteTableExists,
  quarantineSqliteFiles,
  recoveryMessage,
  sha1,
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
  findBestWatchedRootForFile,
  scanFoldersRuntime,
  sendFontIndexChanged: (payload: FontIndexChangePayload) =>
    sendFontIndexChanged(payload),
  syncMergedIndexForRootSnapshot,
  syncMergedIndexForRootIncremental,
  isRootIndexDbPath,
});

const {
  fontIndexDeleteRecord,
  upsertFontIndexEntry,
  removeFontIndexEntriesForPath,
  makeRootScanCacheContext,
  fontIndexEntryChanged,
  refreshWatchedFolder,
  relativeDirectoryPathForRoot,
  cacheKeyInsideDirectory,
  readRootDirectorySignatures,
  saveRootDirectorySignatures,
  listFontFilesWithDirectoryCache,
} = manualFolderRefreshRuntime;

const fontActivationRuntime = createFontActivationRuntime({
  appName: APP_NAME,
  dataPath,
  dataRoot,
  ensureWindows,
  currentUserFontsDir,
  normalizePathForCacheCompare,
  isTemporaryActiveInstalledRecord,
  compareFontInstalledWithList,
  clearInstalledFontsMemoryCache,
  getSystemInstalledFontsCached,
  readInstallStatusIndex,
  saveInstallStatusIndex,
  scheduleActivationInstallStatusSave,
  loadTemporaryActiveFonts,
  saveTemporaryActiveFonts,
  safeTemporaryActiveFontName,
  temporaryActiveRegistryNameFor,
  removeFontResourceSession,
  removeFontResourceSessionBatch,
  addFontResourceSessionBatch,
  writeFontRegistryValuesHKCUBatch,
  deleteFontRegistryValuesHKCUBatch,
  deleteRegistryValueHKCU,
  requestFontRefresh,
  advancedFontRefresh,
  addFontResourceSession,
  scheduleBackgroundFontRefreshTail,
  withGlobalIo,
  delayToEventLoop,
  appendStartupLog,
  runRustFontActivationFiles: rustCoreWorkerRuntime.runRustFontActivationFiles,
});

const {
  activationTraceStep,
  activateFontSession,
  activateFontSessionsBatch,
  deactivateFontSession,
  deactivateFontSessionsBatch,
  cleanupTemporaryActiveFontsUntilEmpty,
  flushPendingTemporaryFontDeletes,
} = fontActivationRuntime;

const systemFontInstallRuntime = createSystemFontInstallRuntime({
  fontExtensions: FONT_EXTENSIONS,
  ensureWindows,
  currentUserFontsDir,
  windowsFontsDir,
  registryNameFor,
  normalizePathForCacheCompare,
  normalizeCompareText,
  isCleanWindowsDefaultFontName,
  isCleanWindowsDefaultCandidate,
  isCleanWindowsDefaultItem,
  isTemporaryActiveInstalledRecord,
  isPathInsideAnyRoot,
  getSystemInstalledFonts,
  getSystemInstalledFontsCached,
  clearInstalledFontsMemoryCache,
  writeFontRegistryValuesHKCUBatch,
  deleteFontRegistryValuesHKCUBatch,
  advancedFontRefresh,
  activationTraceStep,
  appendStartupLog,
});

const {
  installFontSystemWide,
  uninstallFontSystemWide,
  deleteFontFilesToTrash,
} = systemFontInstallRuntime;

const sharedKnownTagsRuntime = createSharedKnownTagsRuntime({
  uniqueResolvedFolders,
  sharedMetadataDbPathForRoot,
  exists,
  openSharedMetadataDb: async (rootPath: string) =>
    openStableSqliteDb(
      sharedMetadataDbPathForRoot(rootPath),
      "shared-metadata-known-tags",
    ),
  closeSqliteDb,
  openLibraryDb,
  loadLibraryShellFromSqlite,
  appendStartupLog,
  runRustSharedMetadataKnownTags:
    rustCoreWorkerRuntime.runRustSharedMetadataKnownTags,
});

const { refreshKnownSharedTagsFromMetadata, renameKnownSharedTagIfUnbound, deleteKnownSharedTagIfUnbound } = sharedKnownTagsRuntime;

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

const sharedMetadataMergedIndexSyncRuntime =
  createSharedMetadataMergedIndexSyncRuntime({
    appendLog: appendStartupLog,
    normalizePathForCacheCompare,
    uniqueResolvedFolders,
    syncMergedIndexForRootIncremental,
    syncMergedIndexForRootSnapshot,
    sendFontIndexChanged: (payload: FontIndexChangePayload) =>
      sendFontIndexChanged(payload),
  });

const sharedFontMetadataMutations = createSharedFontMetadataMutations({
  uniqueResolvedFolders,
  updateSharedFontMetadataEntries,
  removeSharedTagFromMetadataIndexes,
  renameSharedTagInMetadataIndexes,
  invalidateSharedFontRuntimeCaches,
  syncSharedMetadataItemsToMergedIndex:
    sharedMetadataMergedIndexSyncRuntime.syncSharedMetadataItemsToMergedIndex,
  syncSharedMetadataRootsToMergedIndex:
    sharedMetadataMergedIndexSyncRuntime.syncSharedMetadataRootsToMergedIndex,
  refreshKnownSharedTagsFromMetadata: async (folders, options) => {
    await refreshKnownSharedTagsFromMetadata(folders, options);
  },
  renameKnownSharedTagIfUnbound,
  deleteKnownSharedTagIfUnbound,
});

const {
  setFontDeleteProtectionInIndex,
  setSharedFontFavoriteInIndex,
  setSharedFontTagsInIndex: setSharedFontTagsInIndexBase,
  setSharedFontTagsBatchInIndex: setSharedFontTagsBatchInIndexBase,
  renameSharedFontTagInIndex: renameSharedFontTagInIndexBase,
  deleteSharedFontTagInIndex: deleteSharedFontTagInIndexBase,
} = sharedFontMetadataMutations;

async function setSharedFontTagsInIndex(
  items: FontItem[],
  watchedFolders: string[],
  tagNames: string[],
): Promise<FontTagUpdateResult> {
  return tagMutationWriteProtocolRuntime.run({
    scope: "shared",
    mutationKind: "shared-tags-set",
    inputIds: (items || []).map((item) => item?.id),
    action: () => setSharedFontTagsInIndexBase(items, watchedFolders, tagNames),
  });
}

async function setSharedFontTagsBatchInIndex(
  items: FontTagBatchItem[],
  watchedFolders: string[],
): Promise<FontTagUpdateResult> {
  return tagMutationWriteProtocolRuntime.run({
    scope: "shared",
    mutationKind: "shared-tags-batch-set",
    inputIds: (items || []).map((entry) => entry?.item?.id),
    action: () => setSharedFontTagsBatchInIndexBase(items, watchedFolders),
  });
}

async function renameSharedFontTagInIndex(
  oldTagName: string,
  newTagName: string,
  watchedFolders: string[],
): Promise<FontTagUpdateResult> {
  const cleanOld = String(oldTagName || "").trim();
  const cleanNew = String(newTagName || "").trim();
  return tagMutationWriteProtocolRuntime.run({
    scope: "shared",
    mutationKind: `shared-tag-rename:${cleanOld}->${cleanNew}`,
    action: () => renameSharedFontTagInIndexBase(oldTagName, newTagName, watchedFolders),
  });
}

async function deleteSharedFontTagInIndex(
  tagName: string,
  watchedFolders: string[],
): Promise<FontTagUpdateResult> {
  const cleanTag = String(tagName || "").trim();
  return tagMutationWriteProtocolRuntime.run({
    scope: "shared",
    mutationKind: `shared-tag-delete:${cleanTag}`,
    action: () => deleteSharedFontTagInIndexBase(tagName, watchedFolders),
  });
}

const managedFontOwnershipRuntime = createManagedFontOwnershipRuntime({
  currentUserFontsDir,
  safeManagedFontName,
  registryNameFor,
  normalizePathForCompare: normalizePathForCacheCompare,
  findFontItemInRootIndexes,
  authorizeManagedFontDelete,
});

const { installFontForCurrentUser, uninstallManagedFont } =
  createCurrentUserManagedInstallRuntime({
    ensureWindows,
    currentUserFontsDir,
    safeManagedFontName,
    registryNameFor,
    authorizeManagedFontRemoval:
      managedFontOwnershipRuntime.authorizeManagedFontRemoval,
    writeFontRegistryValuesHKCUBatch,
    deleteFontRegistryValuesHKCUBatch,
    broadcastFontChange,
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

installStatusRefreshStarterRuntimeRef =
  createInstallStatusRefreshStarterRuntime({
    createInstallStatusRefreshJobId,
    refreshInstallStatusIndex,
    emitInstallStatusProgress,
    appendLog: appendStartupLog,
  });

const { startInstallStatusRefreshIndex } =
  installStatusRefreshStarterRuntimeRef;

const {
  createPhysicalFolder,
  renamePhysicalFolder,
  listPhysicalFolderTree,
} = createPhysicalFolderActions({
  ensureWindows,
  appendStartupLog,
  authorizePhysicalFolderParent,
  authorizePhysicalFolderRename,
  reconcileWatchedRoot: (rootPath) => refreshWatchedFolder(rootPath, rootPath),
  runRustPhysicalFolderTree: rustCoreWorkerRuntime.runRustPhysicalFolderTree,
});

const { moveFontFileToFolder, moveFontFilesToFolder } =
  createFontMoveTransactionRuntime({
    ensureWindows,
    resolveExistingFontFilePath,
    isProtectedFontPath: (filePath) =>
      pathInsideFolder(filePath, windowsFontsDir()),
    appendStartupLog,
    fontExtensions: FONT_EXTENSIONS,
    authorizeFontMoveSource,
    authorizeFontMoveTarget,
    authorizeFontMoveDestination,
    reconcileWatchedRoot: (rootPath) => refreshWatchedFolder(rootPath, rootPath),
  });

const watchedFolderIndexRuntime = createWatchedFolderIndexRuntime({
  appendStartupLog,
  fontExtensions: FONT_EXTENSIONS,
  isIgnoredWatcherPath,
  cacheKeyForRootFile,
  rootIndexDbPath,
  rootCacheDir,
  exists,
  resolveActiveRootIndexDbPath,
  openRootIndexDb,
  closeSqliteDb,
  withGlobalIo,
  makeRootScanCacheContext,
  ensureRootScanCacheStorage,
  readRootDirectorySignatures,
  saveRootDirectorySignatures,
  relativeDirectoryPathForRoot,
  listFontFilesWithDirectoryCache,
  upsertFontIndexEntry,
  fontIndexEntryChanged,
  cacheKeyInsideDirectory,
  fontIndexDeleteRecord,
  removeFontIndexEntriesForPath,
  saveRootIndexSqliteChanges,
  saveScanCacheFile,
  writeRootCacheManifest,
  fontScanCacheVersion: FONT_SCAN_CACHE_VERSION,
  runRustWatcherPreflight: rustCoreWorkerRuntime.runRustWatcherPreflight,
});

const folderWatcherRuntime = createFolderWatcherRuntime({
  appendStartupLog,
  isIgnoredWatcherPath,
  verboseLogs: VERBOSE_RENDERER_LOGS,
  startupGraceMs: WATCHER_STARTUP_GRACE_MS,
  flushDebounceMs: WATCHER_FLUSH_DEBOUNCE_MS,
  closeRuntimeDatabases: () => {
    try {
      closePreviewDb();
    } catch {
      /* ignore */
    }
    try {
      closeTasksDb();
    } catch {
      /* ignore */
    }
    try {
      closeLibraryDb();
    } catch {
      /* ignore */
    }
  },
  watcherChangeBatchLooksUnchanged:
    watchedFolderIndexRuntime.watcherChangeBatchLooksUnchanged,
  applyWatchedFolderChangesToIndex:
    watchedFolderIndexRuntime.applyWatchedFolderChangesToIndex,
  syncMergedIndexForRootIncremental,
  isScanActive: () => scanFoldersRuntime().isActive(),
});

const stopFolderWatchers = folderWatcherRuntime.stopFolderWatchers;

sendFontIndexChanged = folderWatcherRuntime.sendFontIndexChanged;

const startWatchingFoldersUnsafe = folderWatcherRuntime.startWatchingFolders;

function startWatchingFolders(folders: string[]): Promise<boolean> {
  return startWatchingFoldersUnsafe(
    normalizeWatchedFontFolders(folders, appendStartupLog),
  );
}

registerMainProcessRuntime(
  createMainRuntimeRegistrationPayload({
    appName: APP_NAME,
    appId: APP_ID,
    buildMarker: BUILD_MARKER,
    logSchemaVersion: LOG_SCHEMA_VERSION,
    cacheArchitectureVersion: CACHE_ARCHITECTURE_VERSION,
    watcherStartupGraceMs: WATCHER_STARTUP_GRACE_MS,
    editionLogLine: "edition v3.0.0 stable release",
    scanTuningLogLine: `scan tuning: cpu=${CPU_COUNT} localWorkers=${LOCAL_SCAN_WORKERS} networkWorkers=${NETWORK_SCAN_WORKERS} workerBatch=${SCAN_WORKER_BATCH_SIZE} statConcurrency=${SCAN_STAT_CONCURRENCY} storageMediaDetect=${WINDOWS_STORAGE_MEDIA_DETECT_ENABLED ? "on" : "off"}`,
    beginStartupSessionSync,
    ensureDataRootSync,
    migrateLegacyUserDataIfNeeded,
    initializeCacheArchitecture: initializeCacheArchitectureV2,
    diagnoseRustCoreWorker: rustCoreWorkerRuntime.diagnoseRustCoreWorker,
    dataRoot,
    dataRootErrorMessage,
    showExistingWindow,
    requestRendererWindowsCloseForQuit,
    logPath,
    ioLaneSummary,
    cleanupTemporaryActiveFontsUntilEmpty,
    flushPendingTemporaryFontDeletes,
    runStartupCriticalSchemaAudit: dataComposition.lifecycle.runStartupCriticalSchemaAudit,
    registerFontProtocol,
    startPerformanceLogSampler,
    stopPerformanceLogSampler,
    flushPerformanceLogs,
    createWindow,
    runStartupDatabaseMaintenance,
    startupDbMaintenanceIdleDelayMs: STARTUP_DB_MAINTENANCE_IDLE_DELAY_MS,
    startupBackgroundTasksEnabled: STARTUP_BACKGROUND_TASKS_ENABLED,
    startBackgroundTaskScheduler,
    stopBackgroundTaskScheduler,
    stopFolderWatchers,
    flushActivationInstallStatusSave,
    hasPendingActivationInstallStatusSave,
    hasInFlightActivationInstallStatusSave,
    setCacheKvs,
    dbQueryWorkerShutdown: dataComposition.lifecycle.dbQueryWorkerShutdown,
    stopRustCoreDaemon: rustCoreWorkerRuntime.stopRustCoreDaemon,
    markCleanShutdownSync,
    flushStartupLogAsync,
    flushStartupLogSync,
    appendStartupLog,
    assertFeatureForChannel: coreComposition.capabilities.assertFeatureForChannel,
    getLicenseStatus: coreComposition.capabilities.getLicenseStatus,
    reportPerformanceEvent,
    loadLibrary,
    loadLibraryShell,
    saveLibrary,
    scanFoldersManaged: async (folders, knownFonts) => {
      const result = await scanFoldersRuntime().scanFoldersManaged(
        folders,
        knownFonts,
      );
      for (const root of result.folders || []) {
        await syncMergedIndexForRootSnapshot(root, "scan-finished");
        await delayToEventLoop();
      }
      return result;
    },
    cancelActiveFontScan: (reason) =>
      scanFoldersRuntime().cancelActiveFontScan(reason),
    activeFontScanStatus: () => scanFoldersRuntime().activeFontScanStatus(),
    loadFolderCache,
    searchFontsInLibrary,
    queryFontsInLibrary,
    queryFontPageInLibrary,
    checkSharedMetadataUpdates: dataComposition.capabilities.checkSharedMetadataUpdates,
    getFontMetricsFromLibrary,
    startWatchingFolders,
    refreshWatchedFolder,
    getCacheStats,
    cacheArchitectureInfo,
    getMigrationDiagnostics: () => migrationDiagnosticsRuntime.snapshot(),
    clearMigrationDiagnostics: () => migrationDiagnosticsRuntime.clear(),
    readSharedMetadataFrontendDiagnostics,
    repairSharedMetadataFromFrontend,
    clearScanCache,
    clearPreviewCache,
    runDatabaseHealthCheck,
    createDatabaseBackup,
    runDatabaseMaintenance,
    readSharedIndexSnapshotFrontendDiagnostics,
    repairSharedIndexSnapshotFromFrontend,
    restoreLatestApplicationDatabase,
    listBackgroundTaskSummaries,
    runBackgroundTaskSchedulerOnce,
    backgroundTaskSchedulerStatus,
    markRendererUserActivity,
    reportRendererLongTask,
    getSystemInstalledFonts,
    scanSystemInstalledFonts,
    compareFontInstalled,
    compareFontsInstalled,
    refreshInstallStatusIndex,
    startInstallStatusRefreshIndex,
    getInstallStatusIndexSnapshot,
    installFontSystemWide,
    uninstallFontSystemWide,
    deleteFontFilesToTrash,
    setFontDeleteProtectionInIndex,
    setSharedFontFavoriteInIndex,
    setLocalFontTags,
    setLocalFontTagsBatch,
    deleteLocalFontTag,
    setSharedFontTagsInIndex,
    setSharedFontTagsBatchInIndex,
    renameSharedFontTagInIndex,
    deleteSharedFontTagInIndex,
    activateFontSession,
    activateFontSessionsBatch,
    deactivateFontSession,
    deactivateFontSessionsBatch,
    installFontForCurrentUser,
    uninstallManagedFont,
    readPreviewFontData,
    renderFontPreviewImage,
    readCachedFontPreviewImage,
    readCachedFontPreviewImages,
    ensureFontPreviewCache,
    getPreviewCacheStatus,
    createPhysicalFolder,
    renamePhysicalFolder,
    listPhysicalFolderTree,
    moveFontFileToFolder,
    moveFontFilesToFolder,
  }),
);
