import type { DatabaseArgument } from './mainDatabasePorts';
import type { FontItem, LibraryState, ScanResult } from "../../shared/types";
import { FONT_EXTENSIONS, INSTALLED_FONTS_TTL_MS, SQLITE_BUSY_TIMEOUT_MS, SQLITE_MMAP_SIZE_BYTES } from "../bootstrap/mainIndexConstants";
import { createCacheArchitectureRuntime } from "../cache/cacheArchitectureRuntime";
import { createCachePathHelpers, fileCacheSignature, sqliteSidecarPaths } from "../cache/cachePaths";
import {
  CACHE_ARCHITECTURE_VERSION,
  EVENTS_SQLITE_SCHEMA_VERSION,
  HASH_SQLITE_SCHEMA_VERSION,
  KVS_SQLITE_SCHEMA_VERSION,
  METRICS_SQLITE_SCHEMA_VERSION,
  PREVIEW_CACHE_DB_DIR_NAME,
  PREVIEW_CACHE_DB_FILE_NAME,
  PREVIEW_CACHE_IMAGES_DIR_NAME,
  PREVIEW_SQLITE_SCHEMA_VERSION,
  ROOT_CACHE_DIR_NAME,
  ROOT_INDEX_DB_DIR_NAME,
  ROOT_INDEX_DB_FILE_NAME,
  ROOT_PREVIEW_CACHE_DIR_NAME,
} from "../cache/constants";
import { writeJsonAtomic } from "../cache/jsonAtomic";
import { createRootArchitectureDatabasesRuntime } from "../cache/rootArchitectureDatabasesRuntime";
import { createScanCacheStorageRuntime } from "../cache/scanCacheStorageRuntime";
import { createApplicationDatabasePaths } from "../db/appDatabasePaths";
import { createDbQueryWorkerRuntime } from "../db/dbQueryWorkerRuntime";
import { ensureSqliteColumn as ensureSqliteColumnRuntime, getSqliteMeta, parseSqliteJson, setSqliteMeta } from "../db/sqliteHelpers";
import { createSqliteRuntime } from "../db/sqliteRuntime";
import { createFolderCacheRuntime, type FolderCacheRuntime, type FolderCacheSource } from "../folders/folderCacheRuntime";
import { createCachedFontRuntime, fontItemFromPath, hasValidFontSignature, readFontMetadata, sha1 } from "../fonts/fontRuntime";
import { createSharedFontMetadataRuntime } from "../indexing/shared-metadata/sharedFontMetadataRuntime";
import { createRootIndexRuntime } from "../indexing/rootIndexRuntime";
import { createInstallStatusRuntime } from "../install/installStatusRuntime";
import { createMainSystemInstalledFontsBootstrap } from "../bootstrap/mainSystemInstalledFontsBootstrap";
import { createLibraryRuntime } from "../library/libraryRuntime";
import { normalizePathForCacheCompare } from "../path/cachePath";
import { findBestWatchedRootForFile, normalizeWatchedFontFolders, uniqueResolvedFolders } from "../path/fontPathPolicy";
import { createPreviewDbRuntime } from "../preview/previewDbRuntime";
import {
  APP_NAME,
  DATABASE_CORRUPT_RETENTION_COUNT,
  FAST_OPEN_SHARED_CACHE_DBS,
  FONT_SCAN_CACHE_VERSION,
  SCRIPT_DETECTION_VERSION,
  SHARED_FONT_MEMORY_CACHE_TTL_MS,
  SQLITE_QUICK_CHECK_INTERVAL_MS,
  SYSTEM_FONT_RESOLVE_BATCH_SIZE,
  VERBOSE_SQLITE_LOGS,
  WATCHER_STARTUP_GRACE_MS,
} from "../app/appRuntimeConfig";
import type { createMainCoreCompositionRuntime } from './mainCoreCompositionRuntime';
import type { createTagMutationStateSignalRuntime } from '../library/tagMutationStateSignalRuntime';
import type { MainDataTaskPorts } from './mainDataTaskPorts';
type Core = ReturnType<typeof createMainCoreCompositionRuntime>;

export interface MainDataStorageOptions {
  execFileAsync: Core['execFileAsync'];
  windowsFontsDir: Core['windows']['windowsFontsDir'];
  currentUserFontsDir: Core['windows']['currentUserFontsDir'];
  resolveExistingFontFilePath: Core['windows']['resolveExistingFontFilePath'];
  rustCoreWorkerRuntime: Pick<Core['rustCoreWorkerRuntime'],
    'runRustSystemInstalledFonts' | 'runRustSharedMetadataApply' |
    'runRustSharedMetadataRemoveTag' | 'runRustSharedMetadataSignature' |
    'runRustSharedMetadataOverlayRead' | 'runRustLocalTagsRead' |
    'runRustLocalTagsSet' | 'runRustLocalTagsDeleteTag' |
    'runRustInstallStatusRead' | 'runRustInstallStatusSave' | 'runRustRootIndexApplyChanges'
  >;
  normalizeCompareText: Core['comparison']['normalizeCompareText'];
  isUsableInstalledNameCandidate: Core['comparison']['isUsableInstalledNameCandidate'];
  withGlobalIo: Core['performance']['withGlobalIo'];
  delayToEventLoop: Core['delayToEventLoop'];
  appendStartupLog: Core['logging']['appendStartupLog'];
  dataPath: Core['paths']['dataPath'];
  nodeRequire: NodeRequire;
  exists: Core['paths']['exists'];
  tagMutationStateSignalRuntime: Pick<ReturnType<typeof createTagMutationStateSignalRuntime>, 'handleSharedMetadataMutationStateSignal' | 'handleLocalTagsMutationStateSignal'>;
  dataRoot: Core['paths']['dataRoot'];
  isCleanWindowsDefaultCompareResult: Core['comparison']['isCleanWindowsDefaultCompareResult'];
  completeBackgroundTask: MainDataTaskPorts['completeBackgroundTask'];
  clearFontQueryCaches: () => void;
  notifyPreviewLibraryShellChanged: () => void;
}

export function createMainDataStorageCompositionRuntime(options: MainDataStorageOptions) {
  const {
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
    completeBackgroundTask,
    clearFontQueryCaches,
    notifyPreviewLibraryShellChanged,
  } = options;
  let folderCacheRuntimeRef: FolderCacheRuntime | null = null;

  const {
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
    db: unknown,
    table: string,
    column: string,
    declaration: string,
  ): void {
    ensureSqliteColumnRuntime(db, table, column, declaration, appendStartupLog);
  }

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
  const databases: {
    closeSqliteDb: DatabaseArgument<typeof closeSqliteDb>;
    sqliteQuickCheck: DatabaseArgument<typeof sqliteQuickCheck>;
    ensureSharedTagOpsBackfilledInOpenDb: DatabaseArgument<typeof ensureSharedTagOpsBackfilledInOpenDb>;
    ensureSharedTagOpsReplayedInOpenDb: DatabaseArgument<typeof ensureSharedTagOpsReplayedInOpenDb>;
    readSharedTagOpsDiagnosticsInOpenDb: DatabaseArgument<typeof readSharedTagOpsDiagnosticsInOpenDb>;
    readSharedTagOpsConflictReportInOpenDb: DatabaseArgument<typeof readSharedTagOpsConflictReportInOpenDb>;
    readSharedMetadataMigrationDiagnosticsInOpenDb: DatabaseArgument<typeof readSharedMetadataMigrationDiagnosticsInOpenDb>;
    repairSharedMetadataInOpenDb: DatabaseArgument<typeof repairSharedMetadataInOpenDb>;
    initializeRootEventsDb: DatabaseArgument<typeof initializeRootEventsDb>;
    initializeRootHashDb: DatabaseArgument<typeof initializeRootHashDb>;
    initializeRootMetricsDb: DatabaseArgument<typeof initializeRootMetricsDb>;
    initializePreviewDb: DatabaseArgument<typeof initializePreviewDb>;
    loadLibraryShellFromSqlite: DatabaseArgument<typeof loadLibraryShellFromSqlite>;
    openStableSqliteDb: (...args: Parameters<typeof openStableSqliteDb>) => unknown;
    getOpenPreviewDb: (...args: Parameters<typeof getOpenPreviewDb>) => unknown;
    getOpenLibraryDb: (...args: Parameters<typeof getOpenLibraryDb>) => unknown;
    openRecoverableApplicationSqliteDb: (...args: Parameters<typeof openRecoverableApplicationSqliteDb>) => Promise<unknown>;
    openSharedMetadataDb: (...args: Parameters<typeof openSharedMetadataDb>) => Promise<unknown>;
    openPreviewDb: (...args: Parameters<typeof openPreviewDb>) => Promise<unknown>;
    openLibraryDb: (...args: Parameters<typeof openLibraryDb>) => Promise<unknown>;
    openKvsDb: (...args: Parameters<typeof openKvsDb>) => Promise<unknown>;
    openEventsDb: (...args: Parameters<typeof openEventsDb>) => Promise<unknown>;
    openHashDb: (...args: Parameters<typeof openHashDb>) => Promise<unknown>;
    openMetricsDb: (...args: Parameters<typeof openMetricsDb>) => Promise<unknown>;
    openMachineInstallDbForRoot: (...args: Parameters<typeof openMachineInstallDbForRoot>) => Promise<unknown>;
    openRootIndexDb: (...args: Parameters<typeof openRootIndexDb>) => Promise<unknown>;
  } = {
    closeSqliteDb,
    sqliteQuickCheck,
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
    loadLibraryShellFromSqlite,
    openStableSqliteDb,
    getOpenPreviewDb,
    getOpenLibraryDb,
    openRecoverableApplicationSqliteDb,
    openSharedMetadataDb,
    openPreviewDb,
    openLibraryDb,
    openKvsDb,
    openEventsDb,
    openHashDb,
    openMetricsDb,
    openMachineInstallDbForRoot,
    openRootIndexDb,
  };
  return {
    ...databases,
    clearLocalPreviewDbHandle,
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
    dbQueryWorkerRuntime,
    recoveryMessage,
    quarantineSqliteFiles,
    restoreLatestDatabaseBackupForLabel,
    applySharedMetadataToMergedRows,
    updateSharedFontMetadataEntries,
    renameSharedTagInMetadataIndexes,
    removeSharedTagFromMetadataIndexes,
    sharedMetadataSignatureForRoot,
    sharedMetadataDbPathForRoot,
    closePreviewDb,
    closeLibraryDb,
    hydrateLocalTagsForFonts,
    localTagsByFontIds,
    setLocalFontTagsBase,
    setLocalFontTagsBatchBase,
    deleteLocalFontTagBase,
    loadLibrary,
    loadLibraryShell,
    saveLibrary,
    setCacheKvs,
    recordCacheEvent,
    upsertFontHashIndex,
    saveMetricsSnapshot,
    cacheArchitectureInfo,
    initializeCacheArchitectureV2,
    checkpointOpenCacheDbs,
    closeCacheDb,
    installStatusDbPathForRoot,
    rootForFontPath,
    saveInstalledTotalSummaryForRoots,
    readInstalledTotalSummaryForRoots,
    readInstallStatusIndex,
    getInstallStatusIndexSnapshot,
    saveInstallStatusIndex,
    saveRootIndexSqliteChanges,
    writeRootCacheManifest,
    withRootCacheWriteLock,
    resolveActiveRootIndexDbPath,
    inspectRootIndexSnapshotMaintenance,
    cleanupRootIndexSnapshotMaintenance,
    sqliteRowToScanEntry,
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
    loadSharedFontsForFoldersFresh,
    appWatchedFolders,
  };
}
