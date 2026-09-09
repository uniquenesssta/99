import type { FontIndexChangePayload } from '../../shared/types';
import {
  FONT_SCAN_CACHE_VERSION,
  INDEX_PROGRESS_EVENT_MIN_INTERVAL_MS,
  SCAN_HASH_FLUSH_BATCH_SIZE,
  SCAN_WORKER_BATCH_SIZE,
  SCAN_WORKER_VERSION,
  SCRIPT_DETECTION_VERSION,
  VERBOSE_RENDERER_LOGS,
  WATCHER_FLUSH_DEBOUNCE_MS,
  WATCHER_STARTUP_GRACE_MS
} from '../app/appRuntimeConfig';
import { FONT_EXTENSIONS } from '../bootstrap/mainIndexConstants';
import { fileCacheSignature, isRootIndexDbPath } from '../cache/cachePaths';
import { sqliteTableExists } from '../db/sqliteHelpers';
import { fontItemFromPath, hasValidFontSignature, sha1 } from '../fonts/fontRuntime';
import { createFontScanWorkers } from '../indexing/fontScanWorkers';
import { createScanOrchestrator } from '../indexing/scanOrchestrator';
import { indexListWorkerSource, scanWorkerSource } from '../indexing/workerSources';
import { findBestWatchedRootForFile, normalizeWatchedFontFolders } from '../path/fontPathPolicy';
import type { MainBackgroundRuntime } from '../tasks/mainBackgroundRuntimeBootstrap';
import { createFolderWatcherRuntime } from '../watcher/folderWatcherRuntime';
import { createManualFolderRefreshRuntime } from '../watcher/manualFolderRefreshRuntime';
import { createWatchedFolderIndexRuntime } from '../watcher/watchedFolderIndexRuntime';
import type { MainOperationsCompositionRuntime } from './mainCompositionContracts';
import type { createMainCoreCompositionRuntime } from './mainCoreCompositionRuntime';
import type { createMainDataCompositionRuntime } from './mainDataCompositionRuntime';
type Core = ReturnType<typeof createMainCoreCompositionRuntime>;
type Data = ReturnType<typeof createMainDataCompositionRuntime>;

export interface MainScanCompositionOptions {
  dataPath: Core['paths']['dataPath'];
  nodeRequire: NodeRequire;
  storageProfileForPath: Core['storage']['storageProfileForPath'];
  scanWorkerCount: Core['storage']['scanWorkerCount'];
  appendStartupLog: Core['logging']['appendStartupLog'];
  emitFontIndexProgress: Core['windows']['emitFontIndexProgress'];
  recheckGlobalIoQueues: Core['performance']['recheckGlobalIoQueues'];
  globalIoSnapshot: Core['performance']['globalIoSnapshot'];
  withGlobalIo: Core['performance']['withGlobalIo'];
  cacheKeyForRootFile: Data['storage']['cacheKeyForRootFile'];
  cacheEntryRuntimePath: Data['storage']['cacheEntryRuntimePath'];
  sanitizeCachedFont: Data['storage']['sanitizeCachedFont'];
  cachedFontForRuntime: Data['storage']['cachedFontForRuntime'];
  ensureRootScanCacheStorage: Data['storage']['ensureRootScanCacheStorage'];
  loadLegacyScanCache: Data['storage']['loadLegacyScanCache'];
  saveScanCacheFile: Data['storage']['saveScanCacheFile'];
  writeRootCacheManifest: Data['storage']['writeRootCacheManifest'];
  openRootIndexDb: Data['storage']['openRootIndexDb'];
  closeSqliteDb: Data['storage']['closeSqliteDb'];
  withRootCacheWriteLock: Data['storage']['withRootCacheWriteLock'];
  saveRootIndexSqliteChanges: Data['storage']['saveRootIndexSqliteChanges'];
  upsertFontHashIndex: Data['storage']['upsertFontHashIndex'];
  recordCacheEvent: Data['storage']['recordCacheEvent'];
  rustCoreWorkerRuntime: Pick<Core['rustCoreWorkerRuntime'], 'runRustFontIndexListWorker' | 'runRustFontParseBatch' | 'runRustWatcherPreflight'>;
  invalidateSharedFontRuntimeCaches: Data['storage']['invalidateSharedFontRuntimeCaches'];
  createFontScanJobId: Core['windows']['createFontScanJobId'];
  delayToEventLoop: Core['delayToEventLoop'];
  rootIndexDbDir: Data['storage']['rootIndexDbDir'];
  rootCacheLockDir: Data['storage']['rootCacheLockDir'];
  rootCacheDir: Data['storage']['rootCacheDir'];
  rootIndexDbPath: Data['storage']['rootIndexDbPath'];
  resolveActiveRootIndexDbPath: Data['storage']['resolveActiveRootIndexDbPath'];
  sqliteQuickCheck: Data['storage']['sqliteQuickCheck'];
  quarantineSqliteFiles: Data['storage']['quarantineSqliteFiles'];
  recoveryMessage: Data['storage']['recoveryMessage'];
  hideDirectoryOnWindows: Data['storage']['hideDirectoryOnWindows'];
  exists: Core['paths']['exists'];
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
  rootPreviewImageDir: Data['storage']['rootPreviewImageDir'];
  rootPreviewDbPath: Data['storage']['rootPreviewDbPath'];
  appWatchedFolders: Data['storage']['appWatchedFolders'];
  syncMergedIndexForRootSnapshot: Data['query']['syncMergedIndexForRootSnapshot'];
  syncMergedIndexForRootIncremental: Data['query']['syncMergedIndexForRootIncremental'];
  isIgnoredWatcherPath: Data['storage']['isIgnoredWatcherPath'];
  closePreviewDb: Data['storage']['closePreviewDb'];
  closeTasksDb: MainBackgroundRuntime['closeTasksDb'];
  closeLibraryDb: Data['storage']['closeLibraryDb'];
  assertFeedbackReady: () => void;
}

export function createMainScanCompositionRuntime(options: MainScanCompositionOptions) {
  const {
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
  } = options;

  function scanFoldersRuntime() { return scanOrchestratorRuntime; }
  function sendFontIndexChanged(payload: FontIndexChangePayload): void { folderWatcherRuntime.sendFontIndexChanged(payload); }

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

  const scanOrchestratorRuntime = createScanOrchestrator({
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

  const startWatchingFoldersUnsafe = folderWatcherRuntime.startWatchingFolders;

  function startWatchingFolders(folders: string[]): Promise<boolean> {
    assertFeedbackReady();
    return startWatchingFoldersUnsafe(
      normalizeWatchedFontFolders(folders, appendStartupLog),
    );
  }
  const scanFoldersManaged: MainOperationsCompositionRuntime['capabilities']['scanFoldersManaged'] = async (folders, knownFonts) => {
    assertFeedbackReady();
    const result = await scanFoldersRuntime().scanFoldersManaged(
      folders,
      knownFonts,
    );
    for (const root of result.folders || []) {
      await syncMergedIndexForRootSnapshot(root, "scan-finished");
      await delayToEventLoop();
    }
    return result;
  };
  const scanFolders = (...args: Parameters<typeof scanOrchestratorRuntime.scanFolders>) => { assertFeedbackReady(); return scanOrchestratorRuntime.scanFolders(...args); };
  const cancelActiveFontScan = (...args: Parameters<typeof scanOrchestratorRuntime.cancelActiveFontScan>) => scanOrchestratorRuntime.cancelActiveFontScan(...args);
  const activeFontScanStatus = () => scanOrchestratorRuntime.activeFontScanStatus();
  const isIndexingActive = () => scanOrchestratorRuntime.isActive();
  const activeScanJobId = () => scanOrchestratorRuntime.activeJobId();

  return {
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
  };
}
