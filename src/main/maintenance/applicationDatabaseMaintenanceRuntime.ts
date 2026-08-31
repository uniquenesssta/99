import { resolve } from "node:path";
import type { LibraryShell } from "../../shared/types";
import type { ApplicationDatabaseLabel } from "../db/sqliteRuntime";
import type { TaskMaintenanceReport } from "../tasks/backgroundTasks";
import type { RootIndexSnapshotMaintenanceReport } from "../indexing/root-index/rootIndexSnapshotRuntime";
import {
createDatabaseMaintenanceRuntime,
type DatabaseFileSpec,
} from "./databaseMaintenance";
import { createSharedIndexSnapshotAutoMaintenanceRuntime } from "./sharedIndexSnapshotAutoMaintenanceRuntime";

export type ApplicationDatabaseMaintenanceRuntimeOptions = {
  appName: string;
  maintenanceSqliteSchemaVersion: number;
  databaseBackupRetentionCount: number;
  autoDatabaseBackupIntervalMs: number;
  previewOkRetentionMs: number;
  previewSqliteSchemaVersion: number;
  backupsRootPath: () => string;
  maintenanceStatePath: () => string;
  dataRoot: () => string;
  librarySqlitePath: () => string;
  tasksSqlitePath: () => string;
  previewSqlitePath: () => string;
  kvsSqlitePath: () => string;
  eventsSqlitePath: () => string;
  hashSqlitePath: () => string;
  metricsSqlitePath: () => string;
  openLibraryDb: () => Promise<any>;
  openTasksDb: () => Promise<any>;
  openPreviewDb: () => Promise<any>;
  openKvsDb: () => Promise<any>;
  openEventsDb: () => Promise<any>;
  openHashDb: () => Promise<any>;
  openMetricsDb: () => Promise<any>;
  closeLibraryDb: () => void;
  closeTasksDb: () => void;
  closePreviewDb: () => void;
  closeCacheDb: (label: "kvs" | "events" | "hash" | "metrics") => void;
  checkpointTasksDb: () => void;
  checkpointOpenCacheDbs: () => void;
  getOpenLibraryDb: () => any | null;
  getOpenPreviewDb: () => any | null;
  loadLibraryShell: () => Promise<LibraryShell>;
  localPreviewImageDir: () => string;
  rootPreviewImageDir: (rootPath: string) => string;
  rootCacheDir: (rootPath: string) => string;
  rootIndexDbPath: (rootPath: string) => string;
  legacyRootPreviewCacheDir: (rootPath: string) => string;
  fallbackPreviewImageDir: (rootPath: string) => string;
  restoreLatestDatabaseBackupForLabel: (
    label: ApplicationDatabaseLabel,
    targetPath: string,
    options?: { beforeReplace?: (backupPath: string) => Promise<void> },
  ) => Promise<{ ok: boolean; backupPath?: string; message: string }>;
  quarantineSqliteFiles: (
    targetPath: string,
    reason: string,
    message: string,
  ) => Promise<unknown>;
  recoveryMessage: (error: unknown) => string;
  exists: (filePath: string) => Promise<boolean>;
  appendStartupLog: (message: string) => void;
  normalizePathForCacheCompare: (value: string) => string;
  runTaskMaintenance: () => Promise<TaskMaintenanceReport>;
  inspectRootIndexSnapshotMaintenance: (cacheDir: string, defaultDbPath: string) => Promise<RootIndexSnapshotMaintenanceReport>;
  cleanupRootIndexSnapshotMaintenance: (cacheDir: string, defaultDbPath: string) => Promise<RootIndexSnapshotMaintenanceReport>;
  runRustDatabaseHealthCheck?: Parameters<typeof createDatabaseMaintenanceRuntime>[0]['runRustDatabaseHealthCheck'];
  runRustDatabaseBackup?: Parameters<typeof createDatabaseMaintenanceRuntime>[0]['runRustDatabaseBackup'];
  runRustPreviewCacheMaintenance?: Parameters<typeof createDatabaseMaintenanceRuntime>[0]['runRustPreviewCacheMaintenance'];
};

export function createApplicationDatabaseMaintenanceRuntime(
  options: ApplicationDatabaseMaintenanceRuntimeOptions,
) {
  const {
    appName,
    maintenanceSqliteSchemaVersion,
    databaseBackupRetentionCount,
    autoDatabaseBackupIntervalMs,
    previewOkRetentionMs,
    previewSqliteSchemaVersion,
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
    runRustDatabaseHealthCheck,
    runRustDatabaseBackup,
    runRustPreviewCacheMaintenance,
  } = options;

  function dbFileSpecs(): DatabaseFileSpec[] {
    return [
      { label: "library", filePath: librarySqlitePath(), open: openLibraryDb },
      { label: "tasks", filePath: tasksSqlitePath(), open: openTasksDb },
      { label: "preview", filePath: previewSqlitePath(), open: openPreviewDb },
      { label: "kvs", filePath: kvsSqlitePath(), open: openKvsDb },
      { label: "events", filePath: eventsSqlitePath(), open: openEventsDb },
      { label: "hash", filePath: hashSqlitePath(), open: openHashDb },
      { label: "metrics", filePath: metricsSqlitePath(), open: openMetricsDb },
    ];
  }

  function closeApplicationDatabaseHandle(
    label: ApplicationDatabaseLabel,
  ): void {
    if (label === "library") {
      closeLibraryDb();
    } else if (label === "tasks") {
      closeTasksDb();
    } else if (label === "preview") {
      closePreviewDb();
    } else if (
      label === "kvs" ||
      label === "events" ||
      label === "hash" ||
      label === "metrics"
    ) {
      closeCacheDb(label);
    }
  }

  function databasePathForLabel(label: ApplicationDatabaseLabel): string {
    if (label === "library") return librarySqlitePath();
    if (label === "tasks") return tasksSqlitePath();
    if (label === "preview") return previewSqlitePath();
    if (label === "kvs") return kvsSqlitePath();
    if (label === "events") return eventsSqlitePath();
    if (label === "hash") return hashSqlitePath();
    return metricsSqlitePath();
  }

  async function collectPreviewMaintenanceDirs(): Promise<string[]> {
    const dirs = new Set<string>([localPreviewImageDir()]);
    try {
      const library = await loadLibraryShell();
      for (const rawFolder of library.folders || []) {
        if (!rawFolder) continue;
        const folder = resolve(rawFolder);
        dirs.add(rootPreviewImageDir(folder));
        dirs.add(legacyRootPreviewCacheDir(folder));
        dirs.add(fallbackPreviewImageDir(folder));
      }
    } catch (error) {
      appendStartupLog(
        `preview maintenance folder lookup skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return Array.from(dirs);
  }

  const { runSharedIndexSnapshotAutoMaintenance } = createSharedIndexSnapshotAutoMaintenanceRuntime({
    loadLibraryShell,
    rootCacheDir,
    rootIndexDbPath,
    inspectRootIndexSnapshotMaintenance,
    cleanupRootIndexSnapshotMaintenance,
    appendStartupLog,
  });

  async function checkpointApplicationDatabases(): Promise<void> {
    checkpointTasksDb();
    for (const db of [getOpenLibraryDb(), getOpenPreviewDb()]) {
      if (!db) continue;
      try {
        db.exec("PRAGMA wal_checkpoint(PASSIVE);");
      } catch {
        // ignore checkpoint errors; quick_check will still report actual corruption
      }
    }
    checkpointOpenCacheDbs();
  }

  return createDatabaseMaintenanceRuntime({
    appName,
    maintenanceSqliteSchemaVersion,
    databaseBackupRetentionCount,
    autoDatabaseBackupIntervalMs,
    previewOkRetentionMs,
    previewSqliteSchemaVersion,
    backupsRootPath,
    maintenanceStatePath,
    dataRoot,
    dbFileSpecs,
    databasePathForLabel,
    closeApplicationDatabaseHandle,
    checkpointApplicationDatabases,
    restoreLatestDatabaseBackupForLabel,
    quarantineSqliteFiles,
    recoveryMessage,
    exists,
    appendStartupLog,
    openPreviewDb,
    previewSqlitePath,
    collectPreviewMaintenanceDirs,
    normalizePathForCacheCompare,
    runTaskMaintenance,
    runSharedIndexSnapshotAutoMaintenance,
    runRustDatabaseHealthCheck,
    runRustDatabaseBackup,
    runRustPreviewCacheMaintenance,
  });
}
