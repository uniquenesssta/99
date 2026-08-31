import type { ApplicationDatabaseLabel } from '../db/sqliteRuntime'
import type { TaskMaintenanceReport } from '../tasks/backgroundTasks'
import type { SharedIndexSnapshotAutoMaintenanceReport } from './sharedIndexSnapshotAutoMaintenanceRuntime'

export type DatabaseHealthItem = {
  label: string
  filePath: string
  ok: boolean
  message: string
}

export type DatabaseBackupItem = {
  label: string
  sourcePath: string
  backupPath?: string
  ok: boolean
  sizeBytes: number
  message: string
}

export type DatabaseBackupReport = {
  ok: boolean
  reason: string
  backupDir: string
  items: DatabaseBackupItem[]
  createdAt: string
}

export type DatabaseRestoreReport = {
  ok: boolean
  label: string
  targetPath: string
  backupPath?: string
  message: string
}

export type PreviewMaintenanceReport = {
  checkedRows: number
  staleRows: number
  removedFiles: number
  removedOrphanFiles: number
  errors: string[]
}

export type DatabaseMaintenanceReport = {
  ok: boolean
  startedAt: string
  finishedAt: string
  health: DatabaseHealthItem[]
  backup?: DatabaseBackupReport
  preview: PreviewMaintenanceReport
  tasks: TaskMaintenanceReport
  sharedIndexSnapshots?: SharedIndexSnapshotAutoMaintenanceReport
  message: string
}

export type DatabaseFileSpec = {
  label: ApplicationDatabaseLabel
  filePath: string
  open: () => Promise<any>
}

export type DatabaseMaintenanceRuntimeOptions = {
  appName: string
  maintenanceSqliteSchemaVersion: number
  databaseBackupRetentionCount: number
  autoDatabaseBackupIntervalMs: number
  previewOkRetentionMs: number
  backupsRootPath: () => string
  maintenanceStatePath: () => string
  dataRoot: () => string
  dbFileSpecs: () => DatabaseFileSpec[]
  databasePathForLabel: (label: ApplicationDatabaseLabel) => string
  closeApplicationDatabaseHandle: (label: ApplicationDatabaseLabel) => void
  checkpointApplicationDatabases: () => Promise<void>
  restoreLatestDatabaseBackupForLabel: (label: ApplicationDatabaseLabel, targetPath: string, options?: { beforeReplace?: (backupPath: string) => Promise<void> }) => Promise<{ ok: boolean; backupPath?: string; message: string }>
  quarantineSqliteFiles: (targetPath: string, reason: string, message: string) => Promise<unknown>
  recoveryMessage: (error: unknown) => string
  exists: (filePath: string) => Promise<boolean>
  appendStartupLog: (message: string) => void
  openPreviewDb: () => Promise<any>
  previewSqlitePath: () => string
  previewSqliteSchemaVersion: number
  collectPreviewMaintenanceDirs: () => Promise<string[]>
  normalizePathForCacheCompare: (value: string) => string
  runTaskMaintenance: () => Promise<TaskMaintenanceReport>
  runSharedIndexSnapshotAutoMaintenance?: () => Promise<SharedIndexSnapshotAutoMaintenanceReport>
  runRustDatabaseHealthCheck?: (input: { items: Array<{ label: string; filePath: string }>; busyTimeoutMs?: number }) => Promise<{ items: DatabaseHealthItem[]; elapsedMs: number; workerMode: 'rust-database-health-check' } | null>
  runRustDatabaseBackup?: (input: { appName: string; schemaVersion: number; dataRoot: string; backupsRoot: string; retentionCount: number; reason: string; createdAt: string; backupDirName: string; items: Array<{ label: string; filePath: string }>; busyTimeoutMs?: number }) => Promise<(DatabaseBackupReport & { elapsedMs: number; workerMode: 'rust-database-backup' }) | null>
  runRustPreviewCacheMaintenance?: (input: { dbPath: string; schemaVersion: number; now: string; previewDirs: string[]; previewOkRetentionMs: number; orphanRetentionMs: number }) => Promise<(PreviewMaintenanceReport & { workerMode: 'rust-preview-cache-maintenance' }) | null>
}
