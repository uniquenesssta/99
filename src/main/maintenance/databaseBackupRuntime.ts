import fs,{ promises as fsp } from 'node:fs'
import { dirname,join } from 'node:path'
import { sqliteStringLiteral, timestampForFileName } from './databaseMaintenanceHelpers'
import type { DatabaseBackupItem, DatabaseBackupReport, DatabaseMaintenanceRuntimeOptions } from './databaseMaintenanceTypes'

export interface DatabaseBackupRuntimeDeps {
  appName: string
  maintenanceSqliteSchemaVersion: number
  databaseBackupRetentionCount: number
  autoDatabaseBackupIntervalMs: number
  backupsRootPath: DatabaseMaintenanceRuntimeOptions['backupsRootPath']
  maintenanceStatePath: DatabaseMaintenanceRuntimeOptions['maintenanceStatePath']
  dataRoot: DatabaseMaintenanceRuntimeOptions['dataRoot']
  dbFileSpecs: DatabaseMaintenanceRuntimeOptions['dbFileSpecs']
  exists: DatabaseMaintenanceRuntimeOptions['exists']
  appendStartupLog: DatabaseMaintenanceRuntimeOptions['appendStartupLog']
  runRustDatabaseBackup?: DatabaseMaintenanceRuntimeOptions['runRustDatabaseBackup']
}

export function createDatabaseBackupRuntime(deps: DatabaseBackupRuntimeDeps) {
  async function backupSqliteDatabase(db: any, label: string, sourcePath: string, backupDir: string): Promise<DatabaseBackupItem> {
    if (!(await deps.exists(sourcePath))) {
      return { label, sourcePath, ok: true, sizeBytes: 0, message: '数据库文件不存在，已跳过。' }
    }

    const backupPath = join(backupDir, `${label}.sqlite`)
    await fsp.rm(backupPath, { force: true }).catch(() => undefined)

    try {
      try {
        db.exec('PRAGMA wal_checkpoint(PASSIVE);')
      } catch {
        // checkpoint failure should not block a consistent SQLite backup
      }

      if (typeof db.backup === 'function') {
        await db.backup(backupPath)
      } else {
        db.exec(`VACUUM INTO ${sqliteStringLiteral(backupPath)};`)
      }

      const stat = await fsp.stat(backupPath)
      return { label, sourcePath, backupPath, ok: true, sizeBytes: stat.size, message: '已备份。' }
    } catch (firstError) {
      try {
        await fsp.rm(backupPath, { force: true }).catch(() => undefined)
        db.exec(`VACUUM INTO ${sqliteStringLiteral(backupPath)};`)
        const stat = await fsp.stat(backupPath)
        return { label, sourcePath, backupPath, ok: true, sizeBytes: stat.size, message: '已通过 VACUUM INTO 备份。' }
      } catch (secondError) {
        return {
          label,
          sourcePath,
          backupPath,
          ok: false,
          sizeBytes: 0,
          message: secondError instanceof Error
            ? secondError.message
            : firstError instanceof Error
              ? firstError.message
              : String(secondError)
        }
      }
    }
  }

  async function pruneOldDatabaseBackups(): Promise<void> {
    try {
      await fsp.mkdir(deps.backupsRootPath(), { recursive: true })
      const entries = await fsp.readdir(deps.backupsRootPath(), { withFileTypes: true })
      const backupDirs = entries
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse()

      for (const name of backupDirs.slice(deps.databaseBackupRetentionCount)) {
        await fsp.rm(join(deps.backupsRootPath(), name), { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (error) {
      deps.appendStartupLog(`database backup retention skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function createDatabaseBackup(reason = 'manual'): Promise<DatabaseBackupReport> {
    const createdAt = new Date().toISOString()
    const backupDirName = timestampForFileName(new Date())
    const specs = deps.dbFileSpecs()
    const rustResult = deps.runRustDatabaseBackup
      ? await deps.runRustDatabaseBackup({
        appName: deps.appName,
        schemaVersion: deps.maintenanceSqliteSchemaVersion,
        dataRoot: deps.dataRoot(),
        backupsRoot: deps.backupsRootPath(),
        retentionCount: deps.databaseBackupRetentionCount,
        reason,
        createdAt,
        backupDirName,
        items: specs.map((spec) => ({ label: spec.label, filePath: spec.filePath }))
      }).catch((error) => {
        deps.appendStartupLog(`rust database backup fallback: ${error instanceof Error ? error.message : String(error)}`)
        return null
      })
      : null
    if (rustResult?.backupDir && rustResult.items.length === specs.length) {
      deps.appendStartupLog(`database backup used rust fast path: reason=${reason}, ok=${rustResult.ok}, dir=${rustResult.backupDir}, elapsed=${rustResult.elapsedMs}ms`)
      return rustResult
    }

    const backupDir = join(deps.backupsRootPath(), backupDirName)
    await fsp.mkdir(backupDir, { recursive: true })

    const items: DatabaseBackupItem[] = []
    for (const spec of specs) {
      try {
        const db = await spec.open()
        items.push(await backupSqliteDatabase(db, spec.label, spec.filePath, backupDir))
      } catch (error) {
        items.push({
          label: spec.label,
          sourcePath: spec.filePath,
          ok: false,
          sizeBytes: 0,
          message: error instanceof Error ? error.message : String(error)
        })
      }
    }

    const report: DatabaseBackupReport = {
      ok: items.every((item) => item.ok),
      reason,
      backupDir,
      items,
      createdAt
    }

    await fsp.writeFile(join(backupDir, 'backup-manifest.json'), JSON.stringify({
      ...report,
      app: deps.appName,
      schemaVersion: deps.maintenanceSqliteSchemaVersion,
      dataRoot: deps.dataRoot()
    }, null, 2), 'utf-8').catch(() => undefined)
    await pruneOldDatabaseBackups()
    deps.appendStartupLog(`database backup finished: reason=${reason}, ok=${report.ok}, dir=${backupDir}`)
    return report
  }

  function loadMaintenanceState(): Record<string, unknown> {
    try {
      if (!fs.existsSync(deps.maintenanceStatePath())) return {}
      const parsed = JSON.parse(fs.readFileSync(deps.maintenanceStatePath(), 'utf-8'))
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  async function saveMaintenanceState(state: Record<string, unknown>): Promise<void> {
    await fsp.mkdir(dirname(deps.maintenanceStatePath()), { recursive: true })
    await fsp.writeFile(deps.maintenanceStatePath(), JSON.stringify(state, null, 2), 'utf-8')
  }

  async function createAutomaticDatabaseBackupIfNeeded(): Promise<DatabaseBackupReport | undefined> {
    const state = loadMaintenanceState()
    const lastAt = typeof state.lastAutoBackupAt === 'string' ? Date.parse(state.lastAutoBackupAt) : 0
    if (Number.isFinite(lastAt) && Date.now() - lastAt < deps.autoDatabaseBackupIntervalMs) return undefined

    const backup = await createDatabaseBackup('automatic')
    if (backup.ok) {
      state.lastAutoBackupAt = new Date().toISOString()
      await saveMaintenanceState(state).catch((error) => {
        deps.appendStartupLog(`automatic database backup state save failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    } else {
      deps.appendStartupLog('automatic database backup failed; next startup remains eligible for retry')
    }
    return backup
  }

  return {
    createDatabaseBackup,
    createAutomaticDatabaseBackupIfNeeded,
  }
}
