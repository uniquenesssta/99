import {
  APP_NAME,
  AUTO_DATABASE_BACKUP_INTERVAL_MS,
  DATABASE_BACKUP_RETENTION_COUNT,
  PREVIEW_OK_RETENTION_MS
} from '../app/appRuntimeConfig';
import { MAINTENANCE_SQLITE_SCHEMA_VERSION, PREVIEW_SQLITE_SCHEMA_VERSION } from '../cache/constants';
import { createSharedMetadataFrontendDiagnosticsRuntime } from '../indexing/shared-metadata/sharedMetadataFrontendDiagnosticsRuntime';
import { createApplicationDatabaseMaintenanceRuntime } from '../maintenance/applicationDatabaseMaintenanceRuntime';
import { createSharedIndexSnapshotFrontendRuntime } from '../maintenance/sharedIndexSnapshotFrontendRuntime';
import { normalizePathForCacheCompare } from '../path/cachePath';
import { uniqueResolvedFolders } from '../path/fontPathPolicy';
import type { MainBackgroundRuntime } from '../tasks/mainBackgroundRuntimeBootstrap';
import type { createMainCoreCompositionRuntime } from './mainCoreCompositionRuntime';
import type { createMainDataCompositionRuntime } from './mainDataCompositionRuntime';
type Core = ReturnType<typeof createMainCoreCompositionRuntime>;
type Data = ReturnType<typeof createMainDataCompositionRuntime>;

export interface MainMaintenanceCompositionOptions {
  appWatchedFolders: Data['storage']['appWatchedFolders'];
  exists: Core['paths']['exists'];
  sharedMetadataDbPathForRoot: Data['storage']['sharedMetadataDbPathForRoot'];
  openSharedMetadataDb: Data['storage']['openSharedMetadataDb'];
  closeSqliteDb: Data['storage']['closeSqliteDb'];
  ensureSharedTagOpsBackfilledInOpenDb: Data['storage']['ensureSharedTagOpsBackfilledInOpenDb'];
  ensureSharedTagOpsReplayedInOpenDb: Data['storage']['ensureSharedTagOpsReplayedInOpenDb'];
  readSharedTagOpsDiagnosticsInOpenDb: Data['storage']['readSharedTagOpsDiagnosticsInOpenDb'];
  readSharedTagOpsConflictReportInOpenDb: Data['storage']['readSharedTagOpsConflictReportInOpenDb'];
  readSharedMetadataMigrationDiagnosticsInOpenDb: Data['storage']['readSharedMetadataMigrationDiagnosticsInOpenDb'];
  repairSharedMetadataInOpenDb: Data['storage']['repairSharedMetadataInOpenDb'];
  appendStartupLog: Core['logging']['appendStartupLog'];
  backupsRootPath: Data['storage']['backupsRootPath'];
  maintenanceStatePath: Data['storage']['maintenanceStatePath'];
  dataRoot: Core['paths']['dataRoot'];
  librarySqlitePath: Data['storage']['librarySqlitePath'];
  tasksSqlitePath: Data['storage']['tasksSqlitePath'];
  previewSqlitePath: Data['storage']['previewSqlitePath'];
  kvsSqlitePath: Data['storage']['kvsSqlitePath'];
  eventsSqlitePath: Data['storage']['eventsSqlitePath'];
  hashSqlitePath: Data['storage']['hashSqlitePath'];
  metricsSqlitePath: Data['storage']['metricsSqlitePath'];
  openLibraryDb: Data['storage']['openLibraryDb'];
  openTasksDb: MainBackgroundRuntime['openTasksDb'];
  openPreviewDb: Data['storage']['openPreviewDb'];
  openKvsDb: Data['storage']['openKvsDb'];
  openEventsDb: Data['storage']['openEventsDb'];
  openHashDb: Data['storage']['openHashDb'];
  openMetricsDb: Data['storage']['openMetricsDb'];
  closeLibraryDb: Data['storage']['closeLibraryDb'];
  closeTasksDb: MainBackgroundRuntime['closeTasksDb'];
  closePreviewDb: Data['storage']['closePreviewDb'];
  closeCacheDb: Data['storage']['closeCacheDb'];
  checkpointTasksDb: MainBackgroundRuntime['checkpointTasksDb'];
  checkpointOpenCacheDbs: Data['storage']['checkpointOpenCacheDbs'];
  getOpenLibraryDb: Data['storage']['getOpenLibraryDb'];
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
  runTaskMaintenance: MainBackgroundRuntime['runTaskMaintenance'];
  inspectRootIndexSnapshotMaintenance: Data['storage']['inspectRootIndexSnapshotMaintenance'];
  cleanupRootIndexSnapshotMaintenance: Data['storage']['cleanupRootIndexSnapshotMaintenance'];
  rustCoreWorkerRuntime: Pick<Core['rustCoreWorkerRuntime'], 'runRustDatabaseHealthCheck' | 'runRustDatabaseBackup' | 'runRustPreviewCacheMaintenance'>;
}

export function createMainMaintenanceCompositionRuntime(options: MainMaintenanceCompositionOptions) {
  const {
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
  } = options;

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
  return {
    readSharedMetadataFrontendDiagnostics,
    repairSharedMetadataFromFrontend,
    runDatabaseHealthCheck,
    createDatabaseBackup,
    restoreLatestApplicationDatabase,
    runDatabaseMaintenance,
    runStartupDatabaseMaintenance,
    readSharedIndexSnapshotFrontendDiagnostics,
    repairSharedIndexSnapshotFromFrontend
  };
}
