import { cacheKeyForPath } from "../cache/cachePaths";
import { PREVIEW_SQLITE_SCHEMA_VERSION } from "../cache/constants";
import { getSqliteMeta } from "../db/sqliteHelpers";
import { runStartupCriticalSchemaAudit } from "../diagnostics/startupSchemaAudit";
import { sha1 } from "../fonts/fontRuntime";
import { normalizePathForCacheCompare } from "../path/cachePath";
import { normalizePreviewCacheIndexStatus, upsertPreviewCacheRows } from "../preview/previewCacheRuntime";
import { createPreviewRuntime } from "../preview/previewRuntime";
import type { createMainCoreCompositionRuntime } from './mainCoreCompositionRuntime';
import type { MainDataCompositionRuntime } from './mainCompositionContracts';
import type { createTagMutationStateSignalRuntime } from '../library/tagMutationStateSignalRuntime';
import type { TagMetadataRevisionBarrierRuntime } from '../library/tagMetadataRevisionBarrierRuntime';
import type { MainDataTaskPorts } from './mainDataTaskPorts';
type Core = ReturnType<typeof createMainCoreCompositionRuntime>;

import { createMainDataStorageCompositionRuntime, type MainDataStorageOptions } from './mainDataStorageCompositionRuntime';
import { createMainDataQueryCompositionRuntime, type MainDataQueryOptions } from './mainDataQueryCompositionRuntime';
export interface MainDataCompositionOptions {
  execFileAsync: Core['execFileAsync'];
  windowsFontsDir: Core['windows']['windowsFontsDir'];
  currentUserFontsDir: Core['windows']['currentUserFontsDir'];
  resolveExistingFontFilePath: Core['windows']['resolveExistingFontFilePath'];
  rustCoreWorkerRuntime: MainDataStorageOptions['rustCoreWorkerRuntime'] &
  MainDataQueryOptions['rustCoreWorkerRuntime'] & Pick<Core['rustCoreWorkerRuntime'],
    'runRustPreviewCacheReadStatus' | 'runRustPreviewCacheApply' |
    'runRustPreviewCacheDelete' | 'runRustPreviewCacheQuery' |
    'runRustPreviewCacheTouch' | 'runRustPreviewCacheBatch' | 'runRustPreviewRenderImage'
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
  isSystemInstalledRecord: Core['comparison']['isSystemInstalledRecord'];
  isPathInWindowsFonts: Core['comparison']['isPathInWindowsFonts'];
  tagMetadataRevisionBarrier: TagMetadataRevisionBarrierRuntime;
  migrationDiagnosticsRuntime: Core['migrationDiagnosticsRuntime'];
  ensureWindows: Core['windows']['ensureWindows'];
  authorizeFontRead: Core['windows']['authorizeFontRead'];
  previewTaskKey: MainDataTaskPorts['previewTaskKey'];
  skipBackgroundTask: MainDataTaskPorts['skipBackgroundTask'];
  upsertBackgroundTask: MainDataTaskPorts['upsertBackgroundTask'];
  startBackgroundTask: MainDataTaskPorts['startBackgroundTask'];
  heartbeatBackgroundTask: MainDataTaskPorts['heartbeatBackgroundTask'];
  failBackgroundTask: MainDataTaskPorts['failBackgroundTask'];
  missingFontPreviewDataUri: Core['windows']['missingFontPreviewDataUri'];
  listPhysicalFolderTree: MainDataCompositionRuntime['capabilities']['listPhysicalFolderTree'];
}

export function createMainDataCompositionRuntime(options: MainDataCompositionOptions) {
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
    isSystemInstalledRecord,
    isPathInWindowsFonts,
    tagMetadataRevisionBarrier,
    migrationDiagnosticsRuntime,
    ensureWindows,
    authorizeFontRead,
    previewTaskKey,
    skipBackgroundTask,
    upsertBackgroundTask,
    startBackgroundTask,
    heartbeatBackgroundTask,
    failBackgroundTask,
    missingFontPreviewDataUri,
    listPhysicalFolderTree,
  } = options;
  let notifyPreviewLibraryShellChanged = (): void => undefined;
  const storage = createMainDataStorageCompositionRuntime({
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
    clearFontQueryCaches: () => query.clearFontQueryCaches(),
    notifyPreviewLibraryShellChanged: () => notifyPreviewLibraryShellChanged()
  });
  const {
    clearLocalPreviewDbHandle,
    getSystemInstalledFonts,
    scanSystemInstalledFonts,
    rootCacheDir,
    rootIndexDbPath,
    rootPreviewCacheDir,
    legacyRootPreviewCacheDir,
    rootPreviewImageDir,
    rootPreviewDbPath,
    localPreviewImageDir,
    cacheKeyForRootFile,
    cachedFontForRuntime,
    cacheEntryRuntimePath,
    librarySqlitePath,
    previewSqlitePath,
    dbQueryWorkerRuntime,
    closeSqliteDb,
    openStableSqliteDb,
    applySharedMetadataToMergedRows,
    sharedMetadataSignatureForRoot,
    initializePreviewDb,
    openPreviewDb,
    closePreviewDb,
    openLibraryDb,
    closeLibraryDb,
    loadLibraryShellFromSqlite,
    hydrateLocalTagsForFonts,
    localTagsByFontIds,
    loadLibrary,
    loadLibraryShell,
    setCacheKvs,
    saveMetricsSnapshot,
    cacheArchitectureInfo,
    initializeCacheArchitectureV2,
    checkpointOpenCacheDbs,
    closeCacheDb,
    installStatusDbPathForRoot,
    openMachineInstallDbForRoot,
    readInstallStatusIndex,
    getInstallStatusIndexSnapshot,
    openRootIndexDb,
    resolveActiveRootIndexDbPath,
    sqliteRowToScanEntry,
    hideDirectoryOnWindows,
    writeRootPreviewCacheManifest,
    getCacheStats,
    clearScanCache,
    clearPreviewCache,
    loadFolderCache,
    invalidateSharedFontRuntimeCaches,
    loadSharedFontsForFolders,
    loadSharedFontsForFoldersFresh,
    appWatchedFolders,
  } = storage;
  const query = createMainDataQueryCompositionRuntime({
    appWatchedFolders,
    loadSharedFontsForFolders,
    loadSharedFontsForFoldersFresh,
    hydrateLocalTagsForFonts,
    isSystemInstalledRecord,
    isPathInWindowsFonts,
    appendStartupLog,
    tagMetadataRevisionBarrier,
    rustCoreWorkerRuntime,
    migrationDiagnosticsRuntime,
    dataPath,
    exists,
    openStableSqliteDb,
    openRootIndexDb,
    closeSqliteDb,
    installStatusDbPathForRoot,
    cacheKeyForRootFile,
    dbQueryWorkerRuntime,
    librarySqlitePath,
    openLibraryDb,
    applySharedMetadataToMergedRows,
    sharedMetadataSignatureForRoot,
    delayToEventLoop,
    rootCacheDir,
    rootIndexDbPath,
    resolveActiveRootIndexDbPath,
    openMachineInstallDbForRoot,
    sqliteRowToScanEntry,
    cachedFontForRuntime,
    cacheEntryRuntimePath,
    getInstallStatusIndexSnapshot,
    localTagsByFontIds,
    loadLibraryShellFromSqlite,
    saveMetricsSnapshot,
    readInstallStatusIndex,
  });
  const {
    queryFontPageInLibrary,
    searchFontsInLibrary,
    openMergedIndexDb,
    checkMergedIndexExternalChanges,
    queryFontsInLibrary,
    getFontMetricsFromLibrary,
  } = query;
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
  const checkSharedMetadataUpdates = async (reason?: string) => {
    const result = await checkMergedIndexExternalChanges(reason);
    if (result?.changed || result?.rebuilt) {
      invalidateSharedFontRuntimeCaches();
      appendStartupLog(
        `shared metadata external sync invalidated font query caches: reason=${reason || "shared-metadata-poll"}, changed=${!!result.changed}, rebuilt=${!!result.rebuilt}`,
      );
    }
    return result;
  };
  const lifecycle: MainDataCompositionRuntime['lifecycle'] = {
    initializeCacheArchitecture: initializeCacheArchitectureV2,
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
    dbQueryWorkerShutdown: () => dbQueryWorkerRuntime.shutdown(),
  };
  const resources: MainDataCompositionRuntime['resources'] = {
    closeLibraryDb, closePreviewDb, clearLocalPreviewDbHandle, checkpointOpenCacheDbs, closeCacheDb,
  };
  const capabilities: MainDataCompositionRuntime['capabilities'] = {
    loadLibrary, loadLibraryShell, loadFolderCache, searchFontsInLibrary, queryFontsInLibrary,
    queryFontPageInLibrary, checkSharedMetadataUpdates, getFontMetricsFromLibrary,
    getCacheStats, cacheArchitectureInfo, clearScanCache, clearPreviewCache, setCacheKvs,
    getSystemInstalledFonts, scanSystemInstalledFonts, getInstallStatusIndexSnapshot,
    readPreviewFontData, renderFontPreviewImage, readCachedFontPreviewImage, readCachedFontPreviewImages,
    ensureFontPreviewCache, getPreviewCacheStatus, listPhysicalFolderTree,
  };
  return {
    capabilities,
    lifecycle,
    resources,
    storage: {
      clearInstalledFontsMemoryCache: storage.clearInstalledFontsMemoryCache,
      getSystemInstalledFonts: storage.getSystemInstalledFonts,
      getSystemInstalledFontsCached: storage.getSystemInstalledFontsCached,
      scanSystemInstalledFonts: storage.scanSystemInstalledFonts,
      rootCacheDir: storage.rootCacheDir,
      rootIndexDbDir: storage.rootIndexDbDir,
      rootIndexDbPath: storage.rootIndexDbPath,
      rootEventsDbPath: storage.rootEventsDbPath,
      rootHashDbPath: storage.rootHashDbPath,
      rootMetricsDbPath: storage.rootMetricsDbPath,
      rootCacheLockDir: storage.rootCacheLockDir,
      rootPreviewCacheDir: storage.rootPreviewCacheDir,
      legacyRootPreviewCacheDir: storage.legacyRootPreviewCacheDir,
      rootPreviewImageDir: storage.rootPreviewImageDir,
      rootPreviewDbPath: storage.rootPreviewDbPath,
      fallbackPreviewImageDir: storage.fallbackPreviewImageDir,
      localPreviewImageDir: storage.localPreviewImageDir,
      cacheKeyForRootFile: storage.cacheKeyForRootFile,
      isIgnoredWatcherPath: storage.isIgnoredWatcherPath,
      sanitizeCachedFont: storage.sanitizeCachedFont,
      cachedFontForRuntime: storage.cachedFontForRuntime,
      cacheEntryRuntimePath: storage.cacheEntryRuntimePath,
      librarySqlitePath: storage.librarySqlitePath,
      tasksSqlitePath: storage.tasksSqlitePath,
      previewSqlitePath: storage.previewSqlitePath,
      kvsSqlitePath: storage.kvsSqlitePath,
      eventsSqlitePath: storage.eventsSqlitePath,
      hashSqlitePath: storage.hashSqlitePath,
      metricsSqlitePath: storage.metricsSqlitePath,
      backupsRootPath: storage.backupsRootPath,
      maintenanceStatePath: storage.maintenanceStatePath,
      closeSqliteDb: storage.closeSqliteDb,
      recoveryMessage: storage.recoveryMessage,
      sqliteQuickCheck: storage.sqliteQuickCheck,
      openStableSqliteDb: storage.openStableSqliteDb,
      quarantineSqliteFiles: storage.quarantineSqliteFiles,
      restoreLatestDatabaseBackupForLabel: storage.restoreLatestDatabaseBackupForLabel,
      openRecoverableApplicationSqliteDb: storage.openRecoverableApplicationSqliteDb,
      updateSharedFontMetadataEntries: storage.updateSharedFontMetadataEntries,
      renameSharedTagInMetadataIndexes: storage.renameSharedTagInMetadataIndexes,
      removeSharedTagFromMetadataIndexes: storage.removeSharedTagFromMetadataIndexes,
      sharedMetadataDbPathForRoot: storage.sharedMetadataDbPathForRoot,
      openSharedMetadataDb: storage.openSharedMetadataDb,
      ensureSharedTagOpsBackfilledInOpenDb: storage.ensureSharedTagOpsBackfilledInOpenDb,
      ensureSharedTagOpsReplayedInOpenDb: storage.ensureSharedTagOpsReplayedInOpenDb,
      readSharedTagOpsDiagnosticsInOpenDb: storage.readSharedTagOpsDiagnosticsInOpenDb,
      readSharedTagOpsConflictReportInOpenDb: storage.readSharedTagOpsConflictReportInOpenDb,
      readSharedMetadataMigrationDiagnosticsInOpenDb: storage.readSharedMetadataMigrationDiagnosticsInOpenDb,
      repairSharedMetadataInOpenDb: storage.repairSharedMetadataInOpenDb,
      initializeRootEventsDb: storage.initializeRootEventsDb,
      initializeRootHashDb: storage.initializeRootHashDb,
      initializeRootMetricsDb: storage.initializeRootMetricsDb,
      initializePreviewDb: storage.initializePreviewDb,
      openPreviewDb: storage.openPreviewDb,
      getOpenPreviewDb: storage.getOpenPreviewDb,
      closePreviewDb: storage.closePreviewDb,
      openLibraryDb: storage.openLibraryDb,
      getOpenLibraryDb: storage.getOpenLibraryDb,
      closeLibraryDb: storage.closeLibraryDb,
      loadLibraryShellFromSqlite: storage.loadLibraryShellFromSqlite,
      setLocalFontTagsBase: storage.setLocalFontTagsBase,
      setLocalFontTagsBatchBase: storage.setLocalFontTagsBatchBase,
      deleteLocalFontTagBase: storage.deleteLocalFontTagBase,
      loadLibrary: storage.loadLibrary,
      loadLibraryShell: storage.loadLibraryShell,
      saveLibrary: storage.saveLibrary,
      openKvsDb: storage.openKvsDb,
      setCacheKvs: storage.setCacheKvs,
      openEventsDb: storage.openEventsDb,
      recordCacheEvent: storage.recordCacheEvent,
      openHashDb: storage.openHashDb,
      upsertFontHashIndex: storage.upsertFontHashIndex,
      openMetricsDb: storage.openMetricsDb,
      cacheArchitectureInfo: storage.cacheArchitectureInfo,
      initializeCacheArchitectureV2: storage.initializeCacheArchitectureV2,
      checkpointOpenCacheDbs: storage.checkpointOpenCacheDbs,
      closeCacheDb: storage.closeCacheDb,
      rootForFontPath: storage.rootForFontPath,
      saveInstalledTotalSummaryForRoots: storage.saveInstalledTotalSummaryForRoots,
      readInstalledTotalSummaryForRoots: storage.readInstalledTotalSummaryForRoots,
      readInstallStatusIndex: storage.readInstallStatusIndex,
      getInstallStatusIndexSnapshot: storage.getInstallStatusIndexSnapshot,
      saveInstallStatusIndex: storage.saveInstallStatusIndex,
      openRootIndexDb: storage.openRootIndexDb,
      saveRootIndexSqliteChanges: storage.saveRootIndexSqliteChanges,
      writeRootCacheManifest: storage.writeRootCacheManifest,
      withRootCacheWriteLock: storage.withRootCacheWriteLock,
      resolveActiveRootIndexDbPath: storage.resolveActiveRootIndexDbPath,
      inspectRootIndexSnapshotMaintenance: storage.inspectRootIndexSnapshotMaintenance,
      cleanupRootIndexSnapshotMaintenance: storage.cleanupRootIndexSnapshotMaintenance,
      loadLegacyScanCache: storage.loadLegacyScanCache,
      hideDirectoryOnWindows: storage.hideDirectoryOnWindows,
      writeRootPreviewCacheManifest: storage.writeRootPreviewCacheManifest,
      ensureRootScanCacheStorage: storage.ensureRootScanCacheStorage,
      saveScanCacheFile: storage.saveScanCacheFile,
      getCacheStats: storage.getCacheStats,
      clearScanCache: storage.clearScanCache,
      clearPreviewCache: storage.clearPreviewCache,
      ensureSqliteColumn: storage.ensureSqliteColumn,
      loadFolderCache: storage.loadFolderCache,
      invalidateSharedFontRuntimeCaches: storage.invalidateSharedFontRuntimeCaches,
      loadSharedFontsForFolders: storage.loadSharedFontsForFolders,
      appWatchedFolders: storage.appWatchedFolders,
    },
    query: {
      queryFontPageInLibrary: query.queryFontPageInLibrary,
      clearFontQueryCaches: query.clearFontQueryCaches,
      searchFontsInLibrary: query.searchFontsInLibrary,
      syncMergedIndexAfterInstallStatusRefresh: query.syncMergedIndexAfterInstallStatusRefresh,
      syncMergedIndexForRootIncremental: query.syncMergedIndexForRootIncremental,
      syncMergedIndexForRootSnapshot: query.syncMergedIndexForRootSnapshot,
      findFontItemInRootIndexes: query.findFontItemInRootIndexes,
      mainProcessFontIndexContains: query.mainProcessFontIndexContains,
      queryFontsInLibrary: query.queryFontsInLibrary,
      getFontMetricsFromLibrary: query.getFontMetricsFromLibrary,
    },
    preview: {
      getPreviewCacheStatus, ensureFontPreviewImageFile, readPreviewFontData, renderFontPreviewImage,
      readCachedFontPreviewImage, readCachedFontPreviewImages, ensureFontPreviewCache,
    }
  };
}
