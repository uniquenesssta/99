import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createAppDataPaths } from "../app/appDataPaths";
import { createCleanShutdownRuntime } from "../app/cleanShutdownRuntime";
import { createMainWindowAndFontRuntime } from "../app/mainWindowAndFontRuntimeBootstrap";
import { createMainLoggingBootstrap } from "../bootstrap/mainLoggingBootstrap";
import { createMainFontInstallCompareRuntime } from "../bootstrap/mainFontInstallCompareBootstrap";
import { FONT_EXTENSIONS } from "../bootstrap/mainIndexConstants";
import { CACHE_ARCHITECTURE_VERSION } from "../cache/constants";
import { createMigrationDiagnosticsRuntime } from "../diagnostics/migrationDiagnosticsRuntime";
import { createMainLicenseBootstrap } from "../bootstrap/mainLicenseBootstrap";
import { createMainPerformanceRuntime } from "../performance/mainPerformanceRuntimeBootstrap";
import { createStorageProfileRuntime } from "../performance/storageProfileRuntime";
import { createRustCoreWorkerRuntime } from "../rust-core/rustCoreWorkerRuntime";
import {
  APP_ID,
  APP_NAME,
  BUILD_MARKER,
  CPU_COUNT,
  DATA_DIR_NAME,
  DATA_LAYOUT_VERSION,
  LOG_SCHEMA_VERSION,
  INDEX_PROGRESS_EVENT_MIN_INTERVAL_MS,
  LOCAL_SCAN_WORKERS,
  NETWORK_SCAN_WORKERS,
  SCAN_STAT_CONCURRENCY,
  SCAN_WORKER_BATCH_SIZE,
  RUST_CORE_WORKER_ENABLED,
  RUST_CORE_WORKER_REQUIRED,
  VERBOSE_RENDERER_LOGS,
  WATCHER_STARTUP_GRACE_MS,
  WINDOWS_STORAGE_MEDIA_DETECT_ENABLED,
  WINDOWS_STORAGE_MEDIA_DETECT_TIMEOUT_MS,
} from "../app/appRuntimeConfig";
import type { MainCoreCompositionRuntime } from './mainCompositionContracts';
import type { MainPerformanceRuntimeOptions } from '../performance/mainPerformanceRuntimeBootstrap';
import type { MainWindowAndFontRuntimeOptions } from '../app/mainWindowAndFontRuntimeBootstrap';

export type MainCoreCompositionOptions = Pick<MainPerformanceRuntimeOptions,
  'isIndexingActive' | 'activeScanJobId' | 'isInstallStatusRefreshActive' | 'activeBackgroundTaskCount'
> & Pick<MainWindowAndFontRuntimeOptions, 'loadWatchedFontRoots' | 'isMainProcessIndexedFont'> & {
  onDaemonDomainEvent: NonNullable<Parameters<typeof createRustCoreWorkerRuntime>[0]['onDaemonDomainEvent']>;
};

export function createMainCoreCompositionRuntime(options: MainCoreCompositionOptions) {
  const execFileAsync = promisify(execFile);

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

  const rustCoreWorkerRuntime = createRustCoreWorkerRuntime({
    appendStartupLog,
    enabled: RUST_CORE_WORKER_ENABLED,
    required: RUST_CORE_WORKER_REQUIRED,
    onDaemonDomainEvent:
      options.onDaemonDomainEvent,
  });

  const mainPerformanceRuntime = createMainPerformanceRuntime({
    env: process.env,
    localScanWorkers: LOCAL_SCAN_WORKERS,
    appendStartupLog,
    isIndexingActive: options.isIndexingActive,
    activeScanJobId: options.activeScanJobId,
    storageProfileForPath: (filePath: string) => storageProfileForPath(filePath),
    isInstallStatusRefreshActive: options.isInstallStatusRefreshActive,
    activeBackgroundTaskCount: options.activeBackgroundTaskCount,
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
    loadWatchedFontRoots: options.loadWatchedFontRoots,
    isMainProcessIndexedFont: options.isMainProcessIndexedFont,
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
  } = mainWindowAndFontRuntime;

  const { beginStartupSessionSync, markCleanShutdownSync } = createCleanShutdownRuntime({
    dataPath,
    cacheArchitectureVersion: CACHE_ARCHITECTURE_VERSION,
    appendLog: appendStartupLog,
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
  const capabilities: MainCoreCompositionRuntime['capabilities'] = {
    appName: APP_NAME,
    appId: APP_ID,
    buildMarker: BUILD_MARKER,

    logSchemaVersion: LOG_SCHEMA_VERSION,
    cacheArchitectureVersion: CACHE_ARCHITECTURE_VERSION,

    watcherStartupGraceMs: WATCHER_STARTUP_GRACE_MS,

    editionLogLine: "edition v3.0.0 stable release",

    scanTuningLogLine: `scan tuning: cpu=${CPU_COUNT} localWorkers=${LOCAL_SCAN_WORKERS} networkWorkers=${NETWORK_SCAN_WORKERS} workerBatch=${SCAN_WORKER_BATCH_SIZE} statConcurrency=${SCAN_STAT_CONCURRENCY} storageMediaDetect=${WINDOWS_STORAGE_MEDIA_DETECT_ENABLED ? "on" : "off"}`,

    dataRoot,
    dataRootErrorMessage,
    logPath,
    ioLaneSummary,
    appendStartupLog,

    showExistingWindow,
    registerFontProtocol,
    createWindow,

    assertFeatureForChannel: featureGateRuntime.assertFeatureForChannel,
    getLicenseStatus: licenseRuntime.getStatus,

    reportPerformanceEvent,
    markRendererUserActivity,
    reportRendererLongTask,

    getMigrationDiagnostics: () => migrationDiagnosticsRuntime.snapshot(),
    clearMigrationDiagnostics: () => migrationDiagnosticsRuntime.clear()
  };
  const lifecycle: MainCoreCompositionRuntime['lifecycle'] = {
    beginStartupSessionSync,
    ensureDataRootSync,
    migrateLegacyUserDataIfNeeded,

    diagnoseRustCoreWorker: rustCoreWorkerRuntime.diagnoseRustCoreWorker,
    requestRendererWindowsCloseForQuit,

    startPerformanceLogSampler,
    stopPerformanceLogSampler,
    flushPerformanceLogs,

    stopRustCoreDaemon: rustCoreWorkerRuntime.stopRustCoreDaemon,
    markCleanShutdownSync,
    flushStartupLogAsync,
    flushStartupLogSync
  };
  return {

    capabilities,
    lifecycle,
    execFileAsync,
    delayToEventLoop,

    migrationDiagnosticsRuntime,

    rustCoreWorkerRuntime: {
      runRustMergedIndexPageQuery: rustCoreWorkerRuntime.runRustMergedIndexPageQuery,
      runRustMergedIndexRebuild: rustCoreWorkerRuntime.runRustMergedIndexRebuild,
      runRustMergedIndexSync: rustCoreWorkerRuntime.runRustMergedIndexSync,
      runRustMergedIndexIdsQuery: rustCoreWorkerRuntime.runRustMergedIndexIdsQuery,
      runRustMergedIndexMetricsQuery: rustCoreWorkerRuntime.runRustMergedIndexMetricsQuery,
      runRustFontResourceAdd: rustCoreWorkerRuntime.runRustFontResourceAdd,
      runRustFontResourceRemove: rustCoreWorkerRuntime.runRustFontResourceRemove,
      runRustFontRegistryApply: rustCoreWorkerRuntime.runRustFontRegistryApply,
      runRustFontRegistryDelete: rustCoreWorkerRuntime.runRustFontRegistryDelete,
      runRustFontChangeNotify: rustCoreWorkerRuntime.runRustFontChangeNotify,
      runRustSystemInstalledFonts: rustCoreWorkerRuntime.runRustSystemInstalledFonts,
      runRustSharedMetadataApply: rustCoreWorkerRuntime.runRustSharedMetadataApply,
      runRustSharedMetadataRemoveTag: rustCoreWorkerRuntime.runRustSharedMetadataRemoveTag,
      runRustSharedMetadataSignature: rustCoreWorkerRuntime.runRustSharedMetadataSignature,
      runRustSharedMetadataOverlayRead: rustCoreWorkerRuntime.runRustSharedMetadataOverlayRead,
      runRustLocalTagsRead: rustCoreWorkerRuntime.runRustLocalTagsRead,
      runRustLocalTagsSet: rustCoreWorkerRuntime.runRustLocalTagsSet,
      runRustLocalTagsDeleteTag: rustCoreWorkerRuntime.runRustLocalTagsDeleteTag,
      invalidateRustCoreSchedulerCaches: rustCoreWorkerRuntime.invalidateRustCoreSchedulerCaches,
      cancelRustCoreSchedulerScopes: rustCoreWorkerRuntime.cancelRustCoreSchedulerScopes,
      noteRustCoreSchedulerInteractiveActivity: rustCoreWorkerRuntime.noteRustCoreSchedulerInteractiveActivity,
      runRustInstallStatusRead: rustCoreWorkerRuntime.runRustInstallStatusRead,
      runRustInstallStatusSave: rustCoreWorkerRuntime.runRustInstallStatusSave,
      runRustRootIndexApplyChanges: rustCoreWorkerRuntime.runRustRootIndexApplyChanges,
      runRustDatabaseHealthCheck: rustCoreWorkerRuntime.runRustDatabaseHealthCheck,
      runRustDatabaseBackup: rustCoreWorkerRuntime.runRustDatabaseBackup,
      runRustPreviewCacheMaintenance: rustCoreWorkerRuntime.runRustPreviewCacheMaintenance,
      runRustFontIndexListWorker: rustCoreWorkerRuntime.runRustFontIndexListWorker,
      runRustFontParseBatch: rustCoreWorkerRuntime.runRustFontParseBatch,
      runRustFontActivationFiles: rustCoreWorkerRuntime.runRustFontActivationFiles,
      runRustSharedMetadataKnownTags: rustCoreWorkerRuntime.runRustSharedMetadataKnownTags,
      runRustInstallStatusCompare: rustCoreWorkerRuntime.runRustInstallStatusCompare,
      runRustPreviewCacheReadStatus: rustCoreWorkerRuntime.runRustPreviewCacheReadStatus,
      runRustPreviewCacheApply: rustCoreWorkerRuntime.runRustPreviewCacheApply,
      runRustPreviewCacheDelete: rustCoreWorkerRuntime.runRustPreviewCacheDelete,
      runRustPreviewCacheQuery: rustCoreWorkerRuntime.runRustPreviewCacheQuery,
      runRustPreviewCacheTouch: rustCoreWorkerRuntime.runRustPreviewCacheTouch,
      runRustPreviewCacheBatch: rustCoreWorkerRuntime.runRustPreviewCacheBatch,
      runRustPreviewRenderImage: rustCoreWorkerRuntime.runRustPreviewRenderImage,
      runRustPhysicalFolderTree: rustCoreWorkerRuntime.runRustPhysicalFolderTree,
      runRustWatcherPreflight: rustCoreWorkerRuntime.runRustWatcherPreflight,
      diagnoseRustCoreWorker: rustCoreWorkerRuntime.diagnoseRustCoreWorker,
      stopRustCoreDaemon: rustCoreWorkerRuntime.stopRustCoreDaemon
    },

    paths: { appInstallDir, dataRoot, dataPath, exists },

    logging: { appendStartupLog, logPath, flushStartupLogAsync, flushStartupLogSync },

    comparison: {
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
    },

    performance: {
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
    },

    windows: {
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
    },

    storage: { storageProfileForPath, scanWorkerCount }

  };
}
