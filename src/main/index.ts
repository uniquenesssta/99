import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import type {
  FontIndexChangePayload,
  FontItem,
  FontMetricsResult,
  FontQueryPageResult,
  FontQueryRequest,
  FontQueryResult,
  FontSearchResult,
  FontTagBatchItem,
  FontTagUpdateResult,
  InstallCompareResult,
  LibraryState,
  ScanResult,
} from "../shared/types";
import { createFontActivationRuntime } from "./activation/fontActivationRuntime";
import { createMainActivationInstallStatusSaveRuntime } from "./activation/mainActivationInstallStatusSaveRuntime";
import { createAppDataPaths } from "./app/appDataPaths";
import { createCleanShutdownRuntime } from "./app/cleanShutdownRuntime";
import { registerMainProcessRuntime } from "./app/mainProcessRuntimeRegistration";
import { createMainWindowAndFontRuntime } from "./app/mainWindowAndFontRuntimeBootstrap";
import { createMainLoggingBootstrap } from "./bootstrap/mainLoggingBootstrap";
import { createMainFontInstallCompareRuntime } from "./bootstrap/mainFontInstallCompareBootstrap";
import {
  FONT_EXTENSIONS,
  FONT_SEARCH_RESULT_LIMIT_DEFAULT,
  INSTALLED_FONTS_TTL_MS,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_MMAP_SIZE_BYTES,
} from "./bootstrap/mainIndexConstants";
import { createMainRuntimeRegistrationPayload } from "./bootstrap/mainRuntimeRegistrationPayload";
import { createCacheArchitectureRuntime } from "./cache/cacheArchitectureRuntime";
import {
  cacheKeyForPath,
  createCachePathHelpers,
  fileCacheSignature,
  isRootIndexDbPath,
  sqliteSidecarPaths,
} from "./cache/cachePaths";
import {
  CACHE_ARCHITECTURE_VERSION,
  EVENTS_SQLITE_SCHEMA_VERSION,
  HASH_SQLITE_SCHEMA_VERSION,
  KVS_SQLITE_SCHEMA_VERSION,
  MAINTENANCE_SQLITE_SCHEMA_VERSION,
  METRICS_SQLITE_SCHEMA_VERSION,
  PREVIEW_CACHE_DB_DIR_NAME,
  PREVIEW_CACHE_DB_FILE_NAME,
  PREVIEW_CACHE_IMAGES_DIR_NAME,
  PREVIEW_SQLITE_SCHEMA_VERSION,
  ROOT_CACHE_DIR_NAME,
  ROOT_INDEX_DB_DIR_NAME,
  ROOT_INDEX_DB_FILE_NAME,
  ROOT_PREVIEW_CACHE_DIR_NAME,
  TASKS_SQLITE_SCHEMA_VERSION,
} from "./cache/constants";
import { writeJsonAtomic } from "./cache/jsonAtomic";
import { createRootArchitectureDatabasesRuntime } from "./cache/rootArchitectureDatabasesRuntime";
import { createScanCacheStorageRuntime } from "./cache/scanCacheStorageRuntime";
import { createApplicationDatabasePaths } from "./db/appDatabasePaths";
import { createDbQueryWorkerRuntime } from "./db/dbQueryWorkerRuntime";
import {
  ensureSqliteColumn as ensureSqliteColumnRuntime,
  getSqliteMeta,
  parseSqliteJson,
  setSqliteMeta,
  sqliteTableExists,
} from "./db/sqliteHelpers";
import { createSqliteRuntime } from "./db/sqliteRuntime";
import { runStartupCriticalSchemaAudit } from "./diagnostics/startupSchemaAudit";
import { createMigrationDiagnosticsRuntime } from "./diagnostics/migrationDiagnosticsRuntime";
import {
  createFolderCacheRuntime,
  type FolderCacheRuntime,
  type FolderCacheSource,
} from "./folders/folderCacheRuntime";
import {
  createPhysicalFolderActions,
  pathInsideFolder,
} from "./folders/physicalFolders";
import {
  createCachedFontRuntime,
  fontItemFromPath,
  hasValidFontSignature,
  readFontMetadata,
  sha1,
} from "./fonts/fontRuntime";
import { createFontScanWorkers } from "./indexing/fontScanWorkers";
import { createMergedIndexPageRuntime } from "./indexing/mergedIndexPageRuntime";
import { createRootIndexCoordinator } from "./indexing/rootIndexCoordinator";
import { createSharedFontMetadataRuntime } from "./indexing/shared-metadata/sharedFontMetadataRuntime";
import { createSharedMetadataFrontendDiagnosticsRuntime } from "./indexing/shared-metadata/sharedMetadataFrontendDiagnosticsRuntime";
import { createRootIndexRuntime } from "./indexing/rootIndexRuntime";
import {
  createScanOrchestrator,
  type ScanOrchestratorRuntime,
} from "./indexing/scanOrchestrator";
import {
  indexListWorkerSource,
  scanWorkerSource,
} from "./indexing/workerSources";
import { createCurrentUserManagedInstallRuntime } from "./install/currentUserManagedInstallRuntime";
import { createInstallStatusRefreshRuntime } from "./install/installStatusRefreshRuntime";
import {
  createInstallStatusRefreshStarterRuntime,
  type InstallStatusRefreshStarterRuntime,
} from "./install/installStatusRefreshStarterRuntime";
import { createInstallStatusRuntime } from "./install/installStatusRuntime";
import { createSystemFontInstallRuntime } from "./install/systemFontInstallRuntime";
import { createMainSystemInstalledFontsBootstrap } from "./bootstrap/mainSystemInstalledFontsBootstrap";
import {
  isCleanWindowsDefaultCandidate,
  isCleanWindowsDefaultFontName,
  isCleanWindowsDefaultItem,
} from "./install/windowsDefaultFonts";
import { createFontMemoryQueryRuntime } from "./library/fontMemoryQueryRuntime";
import { createFontMetricsRuntime } from "./library/fontMetricsRuntime";
import { createFontPageQueryCacheRuntime } from "./library/fontPageQueryCacheRuntime";
import {
  createFontQueryFacadeRuntime,
  type FontQueryFacadeRuntime,
} from "./library/fontQueryFacadeRuntime";
import { createFontSearchRuntime } from "./library/fontSearchRuntime";
import { createLibraryRuntime } from "./library/libraryRuntime";
import { createSharedFontMetadataMutations } from "./library/sharedFontMetadataMutations";
import { createSharedKnownTagsRuntime } from "./library/sharedKnownTagsRuntime";
import { createSharedMetadataMergedIndexSyncRuntime } from "./library/sharedMetadataMergedIndexSyncRuntime";
import { createTagMetadataRevisionBarrierRuntime } from "./library/tagMetadataRevisionBarrierRuntime";
import { createTagMutationStateSignalRuntime } from "./library/tagMutationStateSignalRuntime";
import { createTagMutationWriteProtocolRuntime } from "./library/tagMutationWriteProtocolRuntime";
import { createMainLicenseBootstrap } from "./bootstrap/mainLicenseBootstrap";
import { createApplicationDatabaseMaintenanceRuntime } from "./maintenance/applicationDatabaseMaintenanceRuntime";
import { createSharedIndexSnapshotFrontendRuntime } from "./maintenance/sharedIndexSnapshotFrontendRuntime";
import { normalizePathForCacheCompare } from "./path/cachePath";
import {
  findBestWatchedRootForFile,
  isPathInsideAnyRoot,
  normalizeWatchedFontFolders,
  uniqueResolvedFolders,
} from "./path/fontPathPolicy";
import { createMainPerformanceRuntime } from "./performance/mainPerformanceRuntimeBootstrap";
import { createStorageProfileRuntime } from "./performance/storageProfileRuntime";
import {
  normalizePreviewCacheIndexStatus,
  upsertPreviewCacheRows,
} from "./preview/previewCacheRuntime";
import { createPreviewDbRuntime } from "./preview/previewDbRuntime";
import { createPreviewRuntime } from "./preview/previewRuntime";
import { createRustCoreWorkerRuntime } from "./rust-core/rustCoreWorkerRuntime";
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
  DATA_DIR_NAME,
  DATA_LAYOUT_VERSION,
  LOG_SCHEMA_VERSION,
  DATABASE_BACKUP_RETENTION_COUNT,
  DATABASE_CORRUPT_RETENTION_COUNT,
  FAILED_TASK_RETENTION_MS,
  FAST_OPEN_SHARED_CACHE_DBS,
  FONT_QUERY_PAGE_CACHE_MAX,
  FONT_QUERY_PAGE_CACHE_TTL_MS,
  FONT_QUERY_RESULT_CACHE_MAX,
  FONT_QUERY_RESULT_CACHE_TTL_MS,
  FONT_SCAN_CACHE_VERSION,
  INDEX_PROGRESS_EVENT_MIN_INTERVAL_MS,
  INSTALL_STATUS_LIGHTWEIGHT_MISSING_THRESHOLD,
  INSTALL_STATUS_REFRESH_BATCH_SIZE,
  LOCAL_SCAN_WORKERS,
  MERGED_INDEX_BACKGROUND_VALIDATE_INTERVAL_MS,
  MERGED_INDEX_SCHEMA_VERSION,
  MERGED_INDEX_STALE_FIRST_PAGE_ENABLED,
  NETWORK_SCAN_WORKERS,
  PREVIEW_OK_RETENTION_MS,
  SAFE_STARTUP_TASK_TYPES,
  SCAN_HASH_FLUSH_BATCH_SIZE,
  SCAN_STAT_CONCURRENCY,
  SCAN_WORKER_BATCH_SIZE,
  SCAN_WORKER_VERSION,
  RUST_CORE_WORKER_ENABLED,
  RUST_CORE_WORKER_REQUIRED,
  SCRIPT_DETECTION_VERSION,
  SHARED_FONT_MEMORY_CACHE_TTL_MS,
  SQLITE_QUICK_CHECK_INTERVAL_MS,
  STARTUP_BACKGROUND_TASKS_ENABLED,
  STARTUP_DB_MAINTENANCE_IDLE_DELAY_MS,
  STARTUP_RECOVER_SCAN_TASKS_ENABLED,
  SYSTEM_FONT_RESOLVE_BATCH_SIZE,
  TASK_ERROR_RETENTION_MS,
  TASK_LOCK_STALE_MS,
  VERBOSE_RENDERER_LOGS,
  VERBOSE_SQLITE_LOGS,
  WATCHER_FLUSH_DEBOUNCE_MS,
  WATCHER_STARTUP_GRACE_MS,
  WINDOWS_STORAGE_MEDIA_DETECT_ENABLED,
  WINDOWS_STORAGE_MEDIA_DETECT_TIMEOUT_MS,
} from "./app/appRuntimeConfig";
const execFileAsync = promisify(execFile);
const nodeRequire = createRequire(import.meta.url);

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
} = createMainFontInstallCompareRuntime(APP_NAME);

const { logPath, flushStartupLogAsync, flushStartupLogSync, appendStartupLog } =
  createMainLoggingBootstrap({ logsDir: () => dataPath("logs") });

const migrationDiagnosticsRuntime = createMigrationDiagnosticsRuntime({
  appendStartupLog,
});
migrationDiagnosticsRuntime.logStartupPolicy();

const tagMetadataRevisionBarrier = createTagMetadataRevisionBarrierRuntime({
  appendStartupLog,
});

const tagMutationStateSignalRuntime = createTagMutationStateSignalRuntime({
  tagMetadataRevisionBarrier,
  clearFontQueryCaches,
  appendStartupLog,
});

const tagMutationWriteProtocolRuntime = createTagMutationWriteProtocolRuntime({
  tagMetadataRevisionBarrier,
  clearFontQueryCaches,
  appendStartupLog,
});

let backgroundTaskSchedulerRuntimeRef: MainBackgroundTaskSchedulerRuntime | null =
  null;
let folderCacheRuntimeRef: FolderCacheRuntime | null = null;
let installStatusRefreshStarterRuntimeRef: InstallStatusRefreshStarterRuntime | null =
  null;
let scanOrchestratorRuntime: ScanOrchestratorRuntime | null = null;
let fontQueryFacadeRuntimeRef: FontQueryFacadeRuntime | null = null;

function requireFontQueryFacadeRuntime(): FontQueryFacadeRuntime {
  if (!fontQueryFacadeRuntimeRef)
    throw new Error("font query facade runtime is not initialized");
  return fontQueryFacadeRuntimeRef;
}
const rustCoreWorkerRuntime = createRustCoreWorkerRuntime({
  appendStartupLog,
  enabled: RUST_CORE_WORKER_ENABLED,
  required: RUST_CORE_WORKER_REQUIRED,
  onDaemonDomainEvent:
    tagMutationStateSignalRuntime.handleRustCoreDaemonDomainEvent,
});

const mainPerformanceRuntime = createMainPerformanceRuntime({
  env: process.env,
  localScanWorkers: LOCAL_SCAN_WORKERS,
  appendStartupLog,
  isIndexingActive: () => Boolean(scanOrchestratorRuntime?.isActive()),
  activeScanJobId: () => scanOrchestratorRuntime?.activeJobId() || "",
  storageProfileForPath: (filePath: string) => storageProfileForPath(filePath),
  isInstallStatusRefreshActive: () =>
    Boolean(
      installStatusRefreshStarterRuntimeRef?.activeInstallStatusRefreshJob(),
    ),
  activeBackgroundTaskCount: () =>
    backgroundTaskSchedulerRuntimeRef?.activeCount() || 0,
});
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
} = mainPerformanceRuntime;

function scanFoldersRuntime(): ScanOrchestratorRuntime {
  if (!scanOrchestratorRuntime)
    throw new Error("scan orchestrator runtime is not initialized");
  return scanOrchestratorRuntime;
}

function delayToEventLoop(): Promise<void> {
  return new Promise((resolveDelay) => setImmediate(resolveDelay));
}

const {
  appInstallDir,
  dataRoot,
  dataPath,
  ensureDataRootSync,
  exists,
  migrateLegacyUserDataIfNeeded,
  dataRootErrorMessage,
} = createAppDataPaths({
  appName: APP_NAME,
  dataDirName: DATA_DIR_NAME,
  dataLayoutVersion: DATA_LAYOUT_VERSION,
  cacheArchitectureVersion: CACHE_ARCHITECTURE_VERSION,
  appendLog: appendStartupLog,
});

const { licenseRuntime, featureGateRuntime } = createMainLicenseBootstrap({
  dataPath,
  appendStartupLog,
});

const mainWindowAndFontRuntime = createMainWindowAndFontRuntime({
  appName: APP_NAME,
  fontExtensions: FONT_EXTENSIONS,
  appInstallDir,
  dataRoot,
  dataPath,
  appendStartupLog,
  verboseRendererLogs: VERBOSE_RENDERER_LOGS,
  indexProgressMinIntervalMs: INDEX_PROGRESS_EVENT_MIN_INTERVAL_MS,
  runRustFontResourceAdd: rustCoreWorkerRuntime.runRustFontResourceAdd,
  runRustFontResourceRemove: rustCoreWorkerRuntime.runRustFontResourceRemove,
  runRustFontRegistryApply: rustCoreWorkerRuntime.runRustFontRegistryApply,
  runRustFontRegistryDelete: rustCoreWorkerRuntime.runRustFontRegistryDelete,
  runRustFontChangeNotify: rustCoreWorkerRuntime.runRustFontChangeNotify,
  loadWatchedFontRoots: appWatchedFolders,
  isMainProcessIndexedFont: mainProcessFontIndexContains,
});

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
} = mainWindowAndFontRuntime;

const {
  systemInstalledFontsRuntime,
  clearInstalledFontsMemoryCache,
  getSystemInstalledFonts,
  getSystemInstalledFontsCached,
  scanSystemInstalledFonts,
} = createMainSystemInstalledFontsBootstrap({
  execFileAsync,
  fontExtensions: FONT_EXTENSIONS,
  installedFontsTtlMs: INSTALLED_FONTS_TTL_MS,
  systemFontResolveBatchSize: SYSTEM_FONT_RESOLVE_BATCH_SIZE,
  windowsFontsDir,
  currentUserFontsDir,
  resolveExistingFontFilePath,
  hasValidFontSignature,
  fontItemFromPath,
  readFontMetadata,
  runRustSystemInstalledFonts:
    rustCoreWorkerRuntime.runRustSystemInstalledFonts,
  sha1,
  normalizeCompareText,
  isUsableInstalledNameCandidate,
  withGlobalIo,
  delayToEventLoop,
  appendStartupLog,
  platform: process.platform,
  env: process.env,
});

const {
  legacyScanCachePath,
  fallbackCacheRootDir,
  fallbackScanCachePath,
  fallbackLegacyScanCachePath,
  rootCacheDir,
  rootScanCachePath,
  rootLegacyScanCachePath,
  rootIndexDbDir,
  rootIndexDbPath,
  rootEventsDbPath,
  rootHashDbPath,
  rootMetricsDbPath,
  rootCacheLockDir,
  rootIndexLockPath,
  fallbackIndexDbPath,
  rootPreviewCacheDir,
  legacyRootPreviewCacheDir,
  rootPreviewImageDir,
  rootPreviewDbPath,
  fallbackPreviewCacheDir,
  fallbackPreviewImageDir,
  fallbackPreviewDbPath,
  localPreviewImageDir,
  cacheKeyForRootFile,
  sharedFontId,
  isIgnoredWatcherPath,
} = createCachePathHelpers({ dataPath, sha1, fontExtensions: FONT_EXTENSIONS });
const { sanitizeCachedFont, cachedFontForRuntime, cacheEntryRuntimePath } =
  createCachedFontRuntime({ sharedFontId });

const applicationDatabasePaths = createApplicationDatabasePaths(dataPath);
const {
  appSqlitePath,
  librarySqlitePath,
  tasksSqlitePath,
  previewSqlitePath,
  kvsSqlitePath,
  eventsSqlitePath,
  hashSqlitePath,
  metricsSqlitePath,
  cacheIdentityPath,
  backupsRootPath,
  corruptDatabasesRootPath,
  maintenanceStatePath,
} = applicationDatabasePaths;

const dbQueryWorkerRuntime = createDbQueryWorkerRuntime({
  dataPath,
  appendStartupLog,
  resolveModulePath: (moduleName: string) => nodeRequire.resolve(moduleName),
});

const sqliteRuntime = createSqliteRuntime({
  appName: APP_NAME,
  nodeRequire,
  normalizePath: normalizePathForCacheCompare,
  sqliteSidecarPaths,
  appendLog: appendStartupLog,
  exists,
  backupsRootPath,
  corruptDatabasesRootPath,
  quickCheckIntervalMs: SQLITE_QUICK_CHECK_INTERVAL_MS,
  fastOpenSharedCacheDbs: FAST_OPEN_SHARED_CACHE_DBS,
  verboseSqliteLogs: VERBOSE_SQLITE_LOGS,
  busyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS,
  mmapSizeBytes: SQLITE_MMAP_SIZE_BYTES,
  corruptRetentionCount: DATABASE_CORRUPT_RETENTION_COUNT,
});

const {
  closeSqliteDb,
  recoveryMessage,
  sqliteQuickCheck,
  openStableSqliteDb,
  quarantineSqliteFiles,
  restoreLatestDatabaseBackupForLabel,
  openRecoverableApplicationSqliteDb,
} = sqliteRuntime;

const sharedFontMetadataRuntime = createSharedFontMetadataRuntime({
  exists,
  openStableSqliteDb,
  closeSqliteDb,
  appendStartupLog,
  uniqueResolvedFolders,
  findBestWatchedRootForFile,
  cacheKeyForRootFile,
  cacheEntryRuntimePath,
  normalizePathForCacheCompare,
  loadExistingFolderCache,
  runRustSharedMetadataApply: rustCoreWorkerRuntime.runRustSharedMetadataApply,
  runRustSharedMetadataRemoveTag:
    rustCoreWorkerRuntime.runRustSharedMetadataRemoveTag,
  runRustSharedMetadataSignature:
    rustCoreWorkerRuntime.runRustSharedMetadataSignature,
  runRustSharedMetadataOverlayRead:
    rustCoreWorkerRuntime.runRustSharedMetadataOverlayRead,
  onSharedMetadataMutationStateSignal: (signal) =>
    tagMutationStateSignalRuntime.handleSharedMetadataMutationStateSignal(
      signal,
      "rust-worker",
    ),
});

const {
  applySharedMetadataOverlay,
  applySharedMetadataToMergedRows,
  updateSharedFontMetadataEntries,
  renameSharedTagInMetadataIndexes,
  removeSharedTagFromMetadataIndexes,
  sharedMetadataSignatureForRoot,
  sharedMetadataDbPathForRoot,
  openSharedMetadataDb,
  ensureSharedTagOpsBackfilledInOpenDb,
  ensureSharedTagOpsReplayedInOpenDb,
  readSharedTagOpsDiagnosticsInOpenDb,
  readSharedTagOpsConflictReportInOpenDb,
  readSharedMetadataMigrationDiagnosticsInOpenDb,
  repairSharedMetadataInOpenDb,
} = sharedFontMetadataRuntime;

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

const rootArchitectureDatabasesRuntime = createRootArchitectureDatabasesRuntime(
  {
    rootIndexDbDir,
    rootEventsDbPath,
    rootHashDbPath,
    rootMetricsDbPath,
    openStableSqliteDb,
    closeSqliteDb,
    setSqliteMeta,
  },
);

const {
  initializeRootEventsDb,
  initializeRootHashDb,
  initializeRootMetricsDb,
  ensureRootArchitectureDatabases,
} = rootArchitectureDatabasesRuntime;

const previewDbRuntime = createPreviewDbRuntime({
  previewSqliteSchemaVersion: PREVIEW_SQLITE_SCHEMA_VERSION,
  previewSqlitePath,
  openRecoverableApplicationSqliteDb,
  closeSqliteDb,
  ensureSqliteColumn: (db, table, column, declaration) =>
    ensureSqliteColumn(db, table, column, declaration),
  setSqliteMeta,
});

const {
  initializePreviewDb,
  openPreviewDb,
  getOpenPreviewDb,
  closePreviewDb,
  clearLocalPreviewDbHandle,
} = previewDbRuntime;

let notifyPreviewLibraryShellChanged = (): void => undefined;

const libraryRuntime = createLibraryRuntime({
  librarySqlitePath,
  openRecoverableApplicationSqliteDb,
  closeSqliteDb,
  ensureSqliteColumn: (db, table, column, declaration) =>
    ensureSqliteColumnRuntime(db, table, column, declaration, appendStartupLog),
  loadSharedFontsForFolders,
  countSharedFontsForFolders,
  invalidateSharedFontRuntimeCaches,
  appendStartupLog,
  runRustLocalTagsRead: rustCoreWorkerRuntime.runRustLocalTagsRead,
  runRustLocalTagsSet: rustCoreWorkerRuntime.runRustLocalTagsSet,
  runRustLocalTagsDeleteTag: rustCoreWorkerRuntime.runRustLocalTagsDeleteTag,
  onLocalTagsMutationStateSignal: (signal) =>
    tagMutationStateSignalRuntime.handleLocalTagsMutationStateSignal(
      signal,
      "rust-worker",
    ),
});

const {
  openLibraryDb,
  getOpenLibraryDb,
  closeLibraryDb,
  loadLibraryShellFromSqlite,
  hydrateLocalTagsForFonts,
  localTagsByFontIds,
  setLocalFontTags: setLocalFontTagsBase,
  setLocalFontTagsBatch: setLocalFontTagsBatchBase,
  deleteLocalFontTag: deleteLocalFontTagBase,
  loadLibrary,
  loadLibraryShell,
  saveLibrary: saveLibraryBase,
} = libraryRuntime;

async function saveLibrary(state: LibraryState): Promise<boolean> {
  const saved = await saveLibraryBase(state);
  if (saved) notifyPreviewLibraryShellChanged();
  return saved;
}

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

const fontSearchRuntime = createFontSearchRuntime();

const { inferFontSearchCategory } = fontSearchRuntime;

const fontMemoryQueryRuntime = createFontMemoryQueryRuntime({
  resultCacheMax: FONT_QUERY_RESULT_CACHE_MAX,
  resultCacheTtlMs: FONT_QUERY_RESULT_CACHE_TTL_MS,
  appWatchedFolders,
  loadSharedFontsForFolders,
  loadSharedFontsForFoldersFresh,
  hydrateLocalTagsForFonts,
  hydrateInstallStatusForFonts,
  normalizePathForCacheCompare,
  isSystemInstalledRecord,
  isPathInWindowsFonts,
  inferFontSearchCategory,
});

const {
  invalidateFontQueryResultCache,
  sharedFontMatchesPathPrefixes,
  compareSharedFonts,
  cleanSharedFontsForQuery,
} = fontMemoryQueryRuntime;

const fontPageQueryCacheRuntime = createFontPageQueryCacheRuntime({
  pageCacheMax: FONT_QUERY_PAGE_CACHE_MAX,
  pageCacheTtlMs: FONT_QUERY_PAGE_CACHE_TTL_MS,
  queryUncached: queryFontPageInLibraryUncached,
  appendStartupLog,
  cacheKeySuffix: (request) =>
    tagMetadataRevisionBarrier.cacheKeySuffixForRequest(request),
});

const { invalidateFontQueryPageCache, queryFontPageInLibrary } =
  fontPageQueryCacheRuntime;

function clearFontQueryCaches(): void {
  invalidateFontQueryResultCache();
  invalidateFontQueryPageCache();
  rustCoreWorkerRuntime.invalidateRustCoreSchedulerCaches([
    "--merged-index-query-page",
    "--merged-index-query-metrics",
    "--merged-index-query-ids",
    "--shared-metadata-signature",
  ]);
  rustCoreWorkerRuntime.cancelRustCoreSchedulerScopes([
    "page-query",
    "metrics",
    "ids-query",
    "shared-metadata-signature",
  ]);
  fontQueryFacadeRuntimeRef?.clearFontMetricsQueryCache();
  rustCoreWorkerRuntime.noteRustCoreSchedulerInteractiveActivity(
    "font-query-cache-clear",
  );
  migrationDiagnosticsRuntime.record({
    source: "font-query-cache",
    kind: "cache-clear",
    reason: "global-font-query-cache-clear",
  });
}

const cacheArchitectureRuntime = createCacheArchitectureRuntime({
  appName: APP_NAME,
  cacheArchitectureVersion: CACHE_ARCHITECTURE_VERSION,
  kvsSqliteSchemaVersion: KVS_SQLITE_SCHEMA_VERSION,
  eventsSqliteSchemaVersion: EVENTS_SQLITE_SCHEMA_VERSION,
  hashSqliteSchemaVersion: HASH_SQLITE_SCHEMA_VERSION,
  metricsSqliteSchemaVersion: METRICS_SQLITE_SCHEMA_VERSION,
  watcherStartupGraceMs: WATCHER_STARTUP_GRACE_MS,
  rootCacheDirName: ROOT_CACHE_DIR_NAME,
  rootIndexDbDirName: ROOT_INDEX_DB_DIR_NAME,
  rootIndexDbFileName: ROOT_INDEX_DB_FILE_NAME,
  rootPreviewCacheDirName: ROOT_PREVIEW_CACHE_DIR_NAME,
  previewCacheDbDirName: PREVIEW_CACHE_DB_DIR_NAME,
  previewCacheDbFileName: PREVIEW_CACHE_DB_FILE_NAME,
  previewCacheImagesDirName: PREVIEW_CACHE_IMAGES_DIR_NAME,
  appSqlitePath,
  previewSqlitePath,
  kvsSqlitePath,
  eventsSqlitePath,
  hashSqlitePath,
  metricsSqlitePath,
  cacheIdentityPath,
  dataRoot,
  exists,
  writeJsonAtomic,
  openRecoverableApplicationSqliteDb,
  closeSqliteDb,
  setSqliteMeta,
  normalizePathForCacheCompare,
  fileCacheSignature,
  sha1,
  appendStartupLog,
});

const {
  openKvsDb,
  setCacheKvs,
  openEventsDb,
  recordCacheEvent,
  openHashDb,
  upsertFontHashIndex,
  openMetricsDb,
  saveMetricsSnapshot,
  cacheArchitectureInfo,
  ensureCacheIdentity,
  initializeCacheArchitectureV2,
  checkpointOpenCacheDbs,
  closeCacheDb,
} = cacheArchitectureRuntime;

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

const installStatusRuntime = createInstallStatusRuntime({
  rootCacheDir,
  dataPath,
  cacheIdentityPath,
  ensureCacheIdentity,
  appWatchedFolders,
  findBestWatchedRootForFile,
  openStableSqliteDb,
  closeSqliteDb,
  setSqliteMeta,
  getSqliteMeta,
  parseSqliteJson,
  exists,
  sha1,
  normalizePathForCacheCompare,
  isCleanWindowsDefaultCompareResult,
  completeBackgroundTask,
  appendStartupLog,
  readInstallStatusIndexInWorker: async (groups) => {
    const rustResult =
      await rustCoreWorkerRuntime.runRustInstallStatusRead(groups);
    if (rustResult) {
      appendStartupLog(
        `machine install status rust read: groups=${groups.length}, known=${Object.keys(rustResult.results || {}).length}, missing=${rustResult.missingIds.length}, elapsed=${rustResult.timings?.elapsed || 0}ms`,
      );
      return rustResult;
    }
    const result = await dbQueryWorkerRuntime.readInstallStatusIndex({
      groups,
    });
    appendStartupLog(
      `machine install status db worker read: groups=${groups.length}, known=${Object.keys(result.results || {}).length}, missing=${result.missingIds.length}, elapsed=${result.timings?.elapsed || 0}ms`,
    );
    return result;
  },
  saveInstallStatusIndexInWorker: async (groups) => {
    const rustResult =
      await rustCoreWorkerRuntime.runRustInstallStatusSave(groups);
    if (rustResult) {
      appendStartupLog(
        `machine install status rust write: groups=${rustResult.groups}, rows=${rustResult.written}, elapsed=${rustResult.timings?.elapsed || 0}ms`,
      );
      return rustResult;
    }
    return dbQueryWorkerRuntime.saveInstallStatusIndex({ groups });
  },
});

const {
  installStatusDbPathForRoot,
  rootForFontPath,
  saveInstalledTotalSummaryForRoots,
  readInstalledTotalSummaryForRoots,
  openMachineInstallDbForRoot,
  readInstallStatusIndex,
  getInstallStatusIndexSnapshot,
  saveInstallStatusIndex,
} = installStatusRuntime;

let syncMergedIndexAfterInstallStatusRefreshRuntime = async (
  _folders: string[],
): Promise<void> => undefined;

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
      syncMergedIndexAfterInstallStatusRefreshRuntime(folders),
    clearFontQueryCaches,
    appendStartupLog,
  });

const rootIndexRuntime = createRootIndexRuntime({
  appName: APP_NAME,
  fontScanCacheVersion: FONT_SCAN_CACHE_VERSION,
  scriptDetectionVersion: SCRIPT_DETECTION_VERSION,
  exists,
  openStableSqliteDb,
  closeSqliteDb,
  appendStartupLog,
  withGlobalIo,
  invalidateSharedFontRuntimeCaches,
  recordCacheEvent,
  runRustRootIndexApplyChanges:
    rustCoreWorkerRuntime.runRustRootIndexApplyChanges,
});

const {
  openRootIndexDb,
  readRootIndexSqliteFile,
  saveRootIndexSqliteFile,
  saveRootIndexSqliteChanges,
  writeRootCacheManifest,
  withRootCacheWriteLock,
  resolveActiveRootIndexDbPath,
  inspectRootIndexSnapshotMaintenance,
  cleanupRootIndexSnapshotMaintenance,
  listRootIndexDatabaseFiles,
  sqliteRowToScanEntry,
} = rootIndexRuntime;

const scanCacheStorageRuntime = createScanCacheStorageRuntime({
  appName: APP_NAME,
  fontScanCacheVersion: FONT_SCAN_CACHE_VERSION,
  previewSqliteSchemaVersion: PREVIEW_SQLITE_SCHEMA_VERSION,
  legacyScanCachePath,
  fallbackCacheRootDir,
  fallbackScanCachePath,
  fallbackLegacyScanCachePath,
  rootCacheDir,
  rootScanCachePath,
  rootLegacyScanCachePath,
  rootIndexDbDir,
  rootIndexDbPath,
  rootCacheLockDir,
  rootIndexLockPath,
  fallbackIndexDbPath,
  rootPreviewCacheDir,
  legacyRootPreviewCacheDir,
  rootPreviewImageDir,
  rootPreviewDbPath,
  fallbackPreviewCacheDir,
  fallbackPreviewImageDir,
  fallbackPreviewDbPath,
  localPreviewImageDir,
  previewSqlitePath,
  loadLibraryShell,
  exists,
  sha1,
  appendStartupLog,
  ensureRootArchitectureDatabases,
  resolveActiveRootIndexDbPath,
  readRootIndexSqliteFile,
  saveRootIndexSqliteFile,
  writeRootCacheManifest,
  withRootCacheWriteLock,
  listRootIndexDatabaseFiles,
  openStableSqliteDb,
  closeSqliteDb,
  initializePreviewDb,
  recoveryMessage,
  quarantineSqliteFiles,
  clearLocalPreviewDbHandle,
});

const {
  loadLegacyScanCache,
  hideDirectoryOnWindows,
  writeRootPreviewCacheManifest,
  ensureRootScanCacheStorage,
  saveScanCacheFile,
  getCacheStats,
  clearScanCache,
  clearPreviewCache,
} = scanCacheStorageRuntime;

folderCacheRuntimeRef = createFolderCacheRuntime({
  fontScanCacheVersion: FONT_SCAN_CACHE_VERSION,
  sharedFontMemoryCacheTtlMs: SHARED_FONT_MEMORY_CACHE_TTL_MS,
  exists,
  rootCacheDir,
  rootIndexDbPath,
  fallbackIndexDbPath,
  fallbackCacheRootDir,
  resolveActiveRootIndexDbPath,
  readRootIndexSqliteFile,
  saveRootIndexSqliteFile,
  saveRootIndexSqliteChanges,
  saveScanCacheFile,
  applySharedMetadataOverlay,
  cacheEntryRuntimePath,
  cachedFontForRuntime,
  sha1,
  recoveryMessage,
  quarantineSqliteFiles,
  appendStartupLog,
  clearExternalFontQueryCaches: clearFontQueryCaches,
});

function ensureSqliteColumn(
  db: any,
  table: string,
  column: string,
  declaration: string,
): void {
  ensureSqliteColumnRuntime(db, table, column, declaration, appendStartupLog);
}

async function searchFontsInLibrary(
  keywordInput: string,
  limitInput?: number,
): Promise<FontSearchResult> {
  return requireFontQueryFacadeRuntime().searchFontsInLibrary(
    keywordInput,
    limitInput,
  );
}

async function hydrateInstallStatusForFonts(
  items: FontItem[],
): Promise<FontItem[]> {
  return requireFontQueryFacadeRuntime().hydrateInstallStatusForFonts(items);
}

const mergedIndexPageRuntime = createMergedIndexPageRuntime({
  dataPath,
  exists,
  openStableSqliteDb,
  openRootIndexDb,
  closeSqliteDb,
  getSqliteMeta,
  setSqliteMeta,
  sqliteTableExists,
  appendStartupLog,
  schemaVersion: MERGED_INDEX_SCHEMA_VERSION,
  staleFirstPageEnabled: MERGED_INDEX_STALE_FIRST_PAGE_ENABLED,
  backgroundValidateIntervalMs: MERGED_INDEX_BACKGROUND_VALIDATE_INTERVAL_MS,
  appWatchedFolders,
  activeRootIndexDbPathForRoot: (rootPath) =>
    rootIndexCoordinator.activeRootIndexDbPathForRoot(rootPath),
  installStatusDbPathForRoot,
  attachInstallStatusDbIfAvailable: (db, rootPath) =>
    rootIndexCoordinator.attachInstallStatusDbIfAvailable(db, rootPath),
  cacheKeyForRootFile,
  pathInsideFolder,
  normalizePathForCacheCompare,
  dbQueryWorkerRuntime,
  rustCoreWorkerRuntime,
  librarySqlitePath,
  openLibraryDb,
  rootIndexSqliteJsonAvailable: (db) =>
    rootIndexCoordinator.rootIndexSqliteJsonAvailable(db),
  fontFromRootIndexPageRow: (rootPath, row) =>
    rootIndexCoordinator.fontFromRootIndexPageRow(rootPath, row),
  hydrateLocalTagsForFonts,
  applySharedMetadataToMergedRows,
  sharedMetadataSignatureForRoot,
  delayToEventLoop,
  tagRevisionSnapshotForRequest: (request) =>
    tagMetadataRevisionBarrier.snapshotForRequest(request),
  onMergedIndexCommitted: ({ reason, sequence, revision }) => {
    clearFontQueryCaches();
    appendStartupLog(
      `local merged index commit invalidated query caches: reason=${reason}, sequence=${sequence}, revision=${revision}`,
    );
  },
});

const {
  mergedIndexDbPath,
  openMergedIndexDb,
  scheduleMergedIndexBackgroundValidation,
  checkMergedIndexExternalChanges,
  syncMergedIndexAfterInstallStatusRefresh,
  syncMergedIndexForRootIncremental,
  syncMergedIndexForRootSnapshot,
  queryFontPageFromMergedIndexWorker,
  queryFontPageFromMergedIndex,
} = mergedIndexPageRuntime;
syncMergedIndexAfterInstallStatusRefreshRuntime =
  syncMergedIndexAfterInstallStatusRefresh;

const rootIndexCoordinator = createRootIndexCoordinator({
  exists,
  rootCacheDir,
  rootIndexDbPath,
  resolveActiveRootIndexDbPath,
  installStatusDbPathForRoot,
  openMachineInstallDbForRoot,
  closeSqliteDb,
  openRootIndexDb,
  sqliteRowToScanEntry,
  cachedFontForRuntime,
  cacheEntryRuntimePath,
  hydrateLocalTagsForFonts,
  compareSharedFonts,
  appWatchedFolders,
  appendStartupLog,
});

const { findFontItemInRootIndexes, queryFontPageFromRootIndexes } =
  rootIndexCoordinator;

async function mainProcessFontIndexContains(identity: {
  comparePath: string;
}): Promise<boolean> {
  return Boolean(await findFontItemInRootIndexes("", identity.comparePath));
}

async function queryFontPageInLibraryUncached(
  request: FontQueryRequest,
  limit: number,
  offset: number,
): Promise<FontQueryPageResult> {
  return requireFontQueryFacadeRuntime().queryFontPageInLibraryUncached(
    request,
    limit,
    offset,
  );
}

async function queryFontsInLibrary(
  requestInput: FontQueryRequest,
): Promise<FontQueryResult> {
  return requireFontQueryFacadeRuntime().queryFontsInLibrary(requestInput);
}

const fontMetricsFallbackRuntime = createFontMetricsRuntime({
  appWatchedFolders,
  loadSharedFontsForFolders,
  hydrateInstallStatusForFonts,
  getInstallStatusIndexSnapshot,
  localTagsByFontIds,
  openLibraryDb,
  loadLibraryShellFromSqlite,
  saveMetricsSnapshot,
  inferFontSearchCategory,
  sharedFontMatchesPathPrefixes,
});

fontQueryFacadeRuntimeRef = createFontQueryFacadeRuntime({
  fontSearchResultLimitDefault: FONT_SEARCH_RESULT_LIMIT_DEFAULT,
  mergedIndexSchemaVersion: MERGED_INDEX_SCHEMA_VERSION,
  appendLog: appendStartupLog,
  appWatchedFolders,
  cleanSharedFontsForQuery,
  hydrateLocalTagsForFonts,
  readInstallStatusIndex,
  queryFontPageFromMergedIndexWorker,
  queryFontPageFromMergedIndex,
  queryFontPageFromRootIndexes,
  scheduleMergedIndexBackgroundValidation,
  dbQueryWorkerRuntime,
  rustCoreWorkerRuntime,
  mergedIndexDbPath,
  librarySqlitePath,
  fontMetricsFallbackRuntime,
  tagMetadataRevisionBarrier,
  migrationDiagnostics: migrationDiagnosticsRuntime,
});

async function getFontMetricsFromLibrary(): Promise<FontMetricsResult> {
  return requireFontQueryFacadeRuntime().getFontMetricsFromLibrary();
}

const { beginStartupSessionSync, markCleanShutdownSync } = createCleanShutdownRuntime({
  dataPath,
  cacheArchitectureVersion: CACHE_ARCHITECTURE_VERSION,
  appendLog: appendStartupLog,
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

const storageProfileRuntime = createStorageProfileRuntime({
  platform: process.platform,
  env: process.env,
  localWorkers: LOCAL_SCAN_WORKERS,
  networkWorkers: NETWORK_SCAN_WORKERS,
  windowsMediaDetectEnabled: WINDOWS_STORAGE_MEDIA_DETECT_ENABLED,
  windowsMediaDetectTimeoutMs: WINDOWS_STORAGE_MEDIA_DETECT_TIMEOUT_MS,
  verbose: VERBOSE_RENDERER_LOGS,
  logger: appendStartupLog,
});

const storageProfileForPath = storageProfileRuntime.storageProfileForPath;
const scanWorkerCount = storageProfileRuntime.scanWorkerCount;

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

function requireFolderCacheRuntime(): FolderCacheRuntime {
  if (!folderCacheRuntimeRef) {
    throw new Error("folder cache runtime is not initialized");
  }
  return folderCacheRuntimeRef;
}

async function loadExistingFolderCache(
  rootPath: string,
): Promise<FolderCacheSource | null> {
  return requireFolderCacheRuntime().loadExistingFolderCache(rootPath);
}

async function loadFolderCache(folders: string[]): Promise<ScanResult> {
  return requireFolderCacheRuntime().loadFolderCache(folders);
}

function invalidateSharedFontRuntimeCaches(): void {
  folderCacheRuntimeRef?.invalidateSharedFontRuntimeCaches();
  clearFontQueryCaches();
}

async function loadSharedFontsForFolders(
  folders: string[],
): Promise<FontItem[]> {
  return requireFolderCacheRuntime().loadSharedFontsForFolders(folders);
}

async function loadSharedFontsForFoldersFresh(
  folders: string[],
): Promise<FontItem[]> {
  const runtime = requireFolderCacheRuntime();
  return typeof runtime.loadSharedFontsForFoldersFresh === "function"
    ? runtime.loadSharedFontsForFoldersFresh(folders)
    : runtime.loadSharedFontsForFolders(folders);
}

async function countSharedFontsForFolders(folders: string[]): Promise<number> {
  return requireFolderCacheRuntime().countSharedFontsForFolders(folders);
}

async function appWatchedFolders(): Promise<string[]> {
  const db = await openLibraryDb();
  return normalizeWatchedFontFolders(
    (
      db
        .prepare("SELECT path FROM folders ORDER BY sort_order")
        .all() as Array<{ path: string }>
    ).map((row) => row.path),
    appendStartupLog,
  );
}

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

const { installFontForCurrentUser, uninstallManagedFont } =
  createCurrentUserManagedInstallRuntime({
    appName: APP_NAME,
    ensureWindows,
    currentUserFontsDir,
    safeManagedFontName,
    registryNameFor,
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
  getPreviewCacheStatus,
  ensureFontPreviewImageFile,
  readPreviewFontData,
  renderFontPreviewImage,
  readCachedFontPreviewImage,
  readCachedFontPreviewImages,
  ensureFontPreviewCache,
  invalidateLibraryShellCache: invalidatePreviewLibraryShellCache,
} = createPreviewRuntime({
  cacheKeyForRootFile,
  rootPreviewCacheDir,
  rootPreviewImageDir,
  rootPreviewDbPath,
  hideDirectoryOnWindows,
  writeRootPreviewCacheManifest,
  appendStartupLog,
  localPreviewImageDir,
  cacheKeyForPath,
  sha1,
  openPreviewDb,
  previewSqlitePath,
  openStableSqliteDb,
  initializePreviewDb,
  closeSqliteDb,
  normalizePathForCacheCompare,
  normalizePreviewCacheIndexStatus,
  upsertPreviewCacheRows,
  loadLibraryShell,
  ensureWindows,
  resolveExistingFontFilePath,
  authorizeFontRead,
  previewTaskKey,
  completeBackgroundTask,
  skipBackgroundTask,
  upsertBackgroundTask,
  startBackgroundTask,
  heartbeatBackgroundTask,
  failBackgroundTask,
  legacyRootPreviewCacheDir,
  execFileAsync,
  withGlobalIo,
  missingFontPreviewDataUri,
  previewSqliteSchemaVersion: PREVIEW_SQLITE_SCHEMA_VERSION,
  runRustPreviewCacheReadStatus:
    rustCoreWorkerRuntime.runRustPreviewCacheReadStatus,
  runRustPreviewCacheApply: rustCoreWorkerRuntime.runRustPreviewCacheApply,
  runRustPreviewCacheDelete: rustCoreWorkerRuntime.runRustPreviewCacheDelete,
  runRustPreviewCacheQuery: rustCoreWorkerRuntime.runRustPreviewCacheQuery,
  runRustPreviewCacheTouch: rustCoreWorkerRuntime.runRustPreviewCacheTouch,
  runRustPreviewCacheBatch: rustCoreWorkerRuntime.runRustPreviewCacheBatch,
  runRustPreviewRenderImage: rustCoreWorkerRuntime.runRustPreviewRenderImage,
});
notifyPreviewLibraryShellChanged = invalidatePreviewLibraryShellCache;

const {
  createPhysicalFolder,
  renamePhysicalFolder,
  listPhysicalFolderTree,
  moveFontFileToFolder,
  moveFontFilesToFolder,
} = createPhysicalFolderActions({
  ensureWindows,
  resolveExistingFontFilePath,
  windowsFontsDir,
  appendStartupLog,
  fontExtensions: FONT_EXTENSIONS,
  authorizePhysicalFolderParent,
  authorizePhysicalFolderRename,
  authorizeFontMoveSource,
  authorizeFontMoveTarget,
  authorizeFontMoveDestination,
  reconcileWatchedRoot: (rootPath) => refreshWatchedFolder(rootPath, rootPath),
  runRustPhysicalFolderTree: rustCoreWorkerRuntime.runRustPhysicalFolderTree,
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
    runStartupCriticalSchemaAudit: () =>
      runStartupCriticalSchemaAudit({
        openMergedIndexDb,
        openMachineInstallDbForRoot,
        openLibraryDb,
        closeSqliteDb,
        getSqliteMeta,
        appWatchedFolders,
        delayToEventLoop,
        appendStartupLog,
      }),
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
    dbQueryWorkerShutdown: () => dbQueryWorkerRuntime.shutdown(),
    stopRustCoreDaemon: rustCoreWorkerRuntime.stopRustCoreDaemon,
    markCleanShutdownSync,
    flushStartupLogAsync,
    flushStartupLogSync,
    appendStartupLog,
    assertFeatureForChannel: featureGateRuntime.assertFeatureForChannel,
    getLicenseStatus: licenseRuntime.getStatus,
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
    checkSharedMetadataUpdates: async (reason?: string) => {
      const result = await checkMergedIndexExternalChanges(reason);
      if (result?.changed || result?.rebuilt) {
        invalidateSharedFontRuntimeCaches();
        appendStartupLog(
          `shared metadata external sync invalidated font query caches: reason=${reason || "shared-metadata-poll"}, changed=${!!result.changed}, rebuilt=${!!result.rebuilt}`,
        );
      }
      return result;
    },
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
