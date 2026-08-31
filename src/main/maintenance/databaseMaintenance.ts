import type { ApplicationDatabaseLabel } from '../db/sqliteRuntime'
import { readSqliteQuickCheckMessage, isoBefore } from './databaseMaintenanceHelpers'
import { createDatabaseBackupRuntime } from './databaseBackupRuntime'
import { createPreviewCacheMaintenanceRuntime } from './previewCacheMaintenanceRuntime'
import type {
  DatabaseBackupReport,
  DatabaseHealthItem,
  DatabaseMaintenanceReport,
  DatabaseMaintenanceRuntimeOptions,
  DatabaseRestoreReport,
} from './databaseMaintenanceTypes'
export type {
  DatabaseBackupItem,
  DatabaseBackupReport,
  DatabaseFileSpec,
  DatabaseHealthItem,
  DatabaseMaintenanceReport,
  DatabaseRestoreReport,
  PreviewMaintenanceReport,
} from './databaseMaintenanceTypes'

export function createDatabaseMaintenanceRuntime(options: DatabaseMaintenanceRuntimeOptions) {
  const {
    appName,
    maintenanceSqliteSchemaVersion,
    databaseBackupRetentionCount,
    autoDatabaseBackupIntervalMs,
    previewOkRetentionMs,
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
    previewSqliteSchemaVersion,
    collectPreviewMaintenanceDirs,
    normalizePathForCacheCompare,
    runTaskMaintenance,
    runSharedIndexSnapshotAutoMaintenance,
    runRustDatabaseHealthCheck,
    runRustDatabaseBackup,
    runRustPreviewCacheMaintenance
  } = options

  const {
    createDatabaseBackup: createDatabaseBackupRaw,
    createAutomaticDatabaseBackupIfNeeded: createAutomaticDatabaseBackupIfNeededRaw,
  } = createDatabaseBackupRuntime({
    appName,
    maintenanceSqliteSchemaVersion,
    databaseBackupRetentionCount,
    autoDatabaseBackupIntervalMs,
    backupsRootPath,
    maintenanceStatePath,
    dataRoot,
    dbFileSpecs,
    exists,
    appendStartupLog,
    runRustDatabaseBackup
  })

  const { runPreviewCacheMaintenance: runPreviewCacheMaintenanceRaw } = createPreviewCacheMaintenanceRuntime({
    previewOkRetentionMs,
    openPreviewDb,
    previewSqlitePath,
    previewSqliteSchemaVersion,
    collectPreviewMaintenanceDirs,
    normalizePathForCacheCompare,
    runRustPreviewCacheMaintenance
  })

  let operationTail: Promise<void> = Promise.resolve()
  let operationSequence = 0

  function enqueueMaintenanceOperation<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const sequence = ++operationSequence
    const queuedAt = Date.now()
    const task = operationTail.catch(() => undefined).then(async () => {
      const startedAt = Date.now()
      appendStartupLog(`database maintenance operation started: sequence=${sequence}, label=${label}, queuedMs=${startedAt - queuedAt}`)
      try {
        return await operation()
      } finally {
        appendStartupLog(`database maintenance operation finished: sequence=${sequence}, label=${label}, elapsedMs=${Date.now() - startedAt}`)
      }
    })
    operationTail = task.then(() => undefined, () => undefined)
    return task
  }

  async function runDatabaseHealthCheckRaw(): Promise<DatabaseHealthItem[]> {
    const specs = dbFileSpecs()

    async function normalizeOptionalMissingHealth(items: DatabaseHealthItem[]): Promise<DatabaseHealthItem[]> {
      const byLabel = new Map(specs.map((spec) => [spec.label, spec]))
      const normalized: DatabaseHealthItem[] = []
      for (const item of items) {
        const spec = byLabel.get(item.label as ApplicationDatabaseLabel)
        if (item.label === 'preview' && spec && !item.ok && !(await exists(spec.filePath))) {
          normalized.push({
            ...item,
            ok: true,
            message: 'optional preview fallback database has not been created yet'
          })
          continue
        }
        normalized.push(item)
      }
      return normalized
    }

    const rustResult = runRustDatabaseHealthCheck
      ? await runRustDatabaseHealthCheck({
        items: specs.map((spec) => ({ label: spec.label, filePath: spec.filePath }))
      }).catch((error) => {
        appendStartupLog(`rust database health check fallback: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      : null
    if (rustResult?.items?.length === specs.length) {
      appendStartupLog(`database health check used rust fast path: count=${rustResult.items.length}, elapsed=${rustResult.elapsedMs}ms`)
      return await normalizeOptionalMissingHealth(rustResult.items)
    }

    const items: DatabaseHealthItem[] = []

    for (const spec of specs) {
      try {
        const db = await spec.open()
        const message = readSqliteQuickCheckMessage(db) || 'ok'
        const ok = message.toLowerCase() === 'ok'
        items.push({ label: spec.label, filePath: spec.filePath, ok, message })
      } catch (error) {
        items.push({
          label: spec.label,
          filePath: spec.filePath,
          ok: false,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }

    return await normalizeOptionalMissingHealth(items)
  }

  async function restoreLatestApplicationDatabaseRaw(label: ApplicationDatabaseLabel): Promise<DatabaseRestoreReport> {
    const targetPath = databasePathForLabel(label)
    closeApplicationDatabaseHandle(label)
    const currentExists = await exists(targetPath)
    const restored = await restoreLatestDatabaseBackupForLabel(label, targetPath, currentExists ? {
      beforeReplace: async () => {
        await quarantineSqliteFiles(
          targetPath,
          `${label}-before-manual-restore`,
          'manual restore requested after a valid backup was confirmed',
        )
      },
    } : undefined)
    if (!restored.ok) {
      return { ok: false, label, targetPath, backupPath: restored.backupPath, message: restored.message }
    }
    return { ok: true, label, targetPath, backupPath: restored.backupPath, message: restored.message }
  }

  async function runDatabaseMaintenanceRaw(options: { createBackup?: boolean; backupReason?: string } = {}): Promise<DatabaseMaintenanceReport> {
    const startedAt = new Date().toISOString()
    let backup: DatabaseBackupReport | undefined
    if (options.createBackup) {
      backup = await createDatabaseBackupRaw(options.backupReason || 'maintenance')
    }

    const health = await runDatabaseHealthCheckRaw()
    const preview = await runPreviewCacheMaintenanceRaw()
    const tasks = await runTaskMaintenance()
    const sharedIndexSnapshots = await runSharedIndexSnapshotAutoMaintenance?.().catch((error) => ({
      ok: false,
      enabled: true,
      checkedRoots: 0,
      cleanedRoots: 0,
      deletedFiles: 0,
      warnings: [error instanceof Error ? error.message : String(error)],
      roots: [],
    }))
    await checkpointApplicationDatabases()

    const ok = health.every((item) => item.ok) && preview.errors.length === 0 && (!backup || backup.ok) && (!sharedIndexSnapshots || sharedIndexSnapshots.ok)
    const report: DatabaseMaintenanceReport = {
      ok,
      startedAt,
      finishedAt: new Date().toISOString(),
      health,
      backup,
      preview,
      tasks,
      sharedIndexSnapshots,
      message: ok ? '数据库维护完成。' : '数据库维护完成，但存在需要查看的警告。'
    }

    appendStartupLog(`database maintenance finished: ok=${report.ok}, previewStale=${preview.staleRows}, previewRemoved=${preview.removedFiles + preview.removedOrphanFiles}, tasksRemoved=${tasks.removedCompleted + tasks.removedFailed}, sharedIndexChecked=${sharedIndexSnapshots?.checkedRoots ?? 0}, sharedIndexDeleted=${sharedIndexSnapshots?.deletedFiles ?? 0}`)
    return report
  }

  async function runStartupDatabaseMaintenanceRaw(): Promise<void> {
    try {
      const initialHealth = await runDatabaseHealthCheckRaw()
      const healthOk = initialHealth.every((item) => item.ok)
      if (!healthOk) {
        appendStartupLog(`startup database health warning before maintenance: ${initialHealth.filter((item) => !item.ok).map((item) => `${item.label}:${item.message}`).join('; ')}`)
      }

      const backup = healthOk ? await createAutomaticDatabaseBackupIfNeededRaw() : undefined
      const report = await runDatabaseMaintenanceRaw({ createBackup: false })
      if (backup) report.backup = backup
      appendStartupLog(`startup database maintenance finished: ok=${report.ok}`)
    } catch (error) {
      appendStartupLog(`startup database maintenance skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    runDatabaseHealthCheck: () => enqueueMaintenanceOperation('health-check', runDatabaseHealthCheckRaw),
    createDatabaseBackup: (reason = 'manual') => enqueueMaintenanceOperation(`backup:${reason}`, () => createDatabaseBackupRaw(reason)),
    restoreLatestApplicationDatabase: (label: ApplicationDatabaseLabel) => enqueueMaintenanceOperation(`restore:${label}`, () => restoreLatestApplicationDatabaseRaw(label)),
    createAutomaticDatabaseBackupIfNeeded: () => enqueueMaintenanceOperation('backup:automatic-if-needed', createAutomaticDatabaseBackupIfNeededRaw),
    runPreviewCacheMaintenance: () => enqueueMaintenanceOperation('preview-cache', runPreviewCacheMaintenanceRaw),
    runDatabaseMaintenance: (maintenanceOptions: { createBackup?: boolean; backupReason?: string } = {}) => enqueueMaintenanceOperation('maintenance', () => runDatabaseMaintenanceRaw(maintenanceOptions)),
    runStartupDatabaseMaintenance: () => enqueueMaintenanceOperation('startup-maintenance', runStartupDatabaseMaintenanceRaw),
  }
}

export { isoBefore }
