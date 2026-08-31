#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const root = path.resolve(__dirname, '..', '..')
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8') }
function assert(condition, message) {
  if (!condition) {
    console.error(`[diagnostics:database-maintenance-serialization] ${message}`)
    process.exit(1)
  }
}
function loadTypeScriptModule(rel, localRequire) {
  const output = ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true
    }
  }).outputText
  const module = { exports: {} }
  new Function('exports', 'require', 'module', '__filename', '__dirname', output)(
    module.exports,
    localRequire,
    module,
    path.join(root, rel),
    path.dirname(path.join(root, rel))
  )
  return module.exports
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

const maintenanceSource = read('src/main/maintenance/databaseMaintenance.ts')
for (const needle of [
  'let operationTail: Promise<void> = Promise.resolve()',
  'enqueueMaintenanceOperation',
  "restoreLatestDatabaseBackupForLabel(label, targetPath, currentExists ? {",
  'manual restore requested after a valid backup was confirmed'
]) assert(maintenanceSource.includes(needle), `maintenance coordinator missing ${needle}`)

const backupSource = read('src/main/maintenance/databaseBackupRuntime.ts')
assert(backupSource.includes('if (backup.ok) {'), 'a failed automatic backup must not advance the 24-hour success timestamp')
assert(backupSource.includes('next startup remains eligible for retry'), 'failed automatic backup retry eligibility must be logged')
assert(read('src/main/maintenance/databaseMaintenanceHelpers.ts').includes('.slice(0, 23)'), 'backup directory names must include milliseconds')

const sqliteSource = read('src/main/db/sqliteRuntime.ts')
assert(sqliteSource.indexOf('assertSqliteFileHealthy(backupPath, `${label}:backup-source`)') < sqliteSource.indexOf('await restoreOptions.beforeReplace?.(backupPath)'), 'backup health must be verified before the current database is moved')

async function runBehaviorChecks() {
  let activeBackups = 0
  let maxActiveBackups = 0
  const backupOrder = []
  let restoreMode = 'missing'
  let quarantineCalls = 0

  const { createDatabaseMaintenanceRuntime } = loadTypeScriptModule(
    'src/main/maintenance/databaseMaintenance.ts',
    (id) => {
      if (id === './databaseMaintenanceHelpers') {
        return { readSqliteQuickCheckMessage: () => 'ok', isoBefore: () => '' }
      }
      if (id === './databaseBackupRuntime') {
        return {
          createDatabaseBackupRuntime: () => ({
            createDatabaseBackup: async (reason) => {
              activeBackups += 1
              maxActiveBackups = Math.max(maxActiveBackups, activeBackups)
              backupOrder.push(`start:${reason}`)
              await delay(20)
              backupOrder.push(`end:${reason}`)
              activeBackups -= 1
              return { ok: true, reason, backupDir: `/backup/${reason}`, items: [], createdAt: new Date().toISOString() }
            },
            createAutomaticDatabaseBackupIfNeeded: async () => undefined
          })
        }
      }
      if (id === './previewCacheMaintenanceRuntime') {
        return {
          createPreviewCacheMaintenanceRuntime: () => ({
            runPreviewCacheMaintenance: async () => ({ staleRows: 0, removedFiles: 0, removedOrphanFiles: 0, errors: [] })
          })
        }
      }
      return require(id)
    }
  )

  const runtime = createDatabaseMaintenanceRuntime({
    appName: 'test',
    maintenanceSqliteSchemaVersion: 1,
    databaseBackupRetentionCount: 2,
    autoDatabaseBackupIntervalMs: 1000,
    previewOkRetentionMs: 1000,
    backupsRootPath: () => '/backup',
    maintenanceStatePath: () => '/state',
    dataRoot: () => '/data',
    dbFileSpecs: () => [],
    databasePathForLabel: (label) => `/data/${label}.sqlite`,
    closeApplicationDatabaseHandle: () => undefined,
    checkpointApplicationDatabases: async () => undefined,
    restoreLatestDatabaseBackupForLabel: async (_label, _target, options) => {
      if (restoreMode === 'missing') return { ok: false, message: '没有可用备份。' }
      await options.beforeReplace('/backup/library.sqlite')
      return { ok: true, backupPath: '/backup/library.sqlite', message: 'ok' }
    },
    quarantineSqliteFiles: async () => { quarantineCalls += 1 },
    recoveryMessage: (error) => String(error),
    exists: async () => true,
    appendStartupLog: () => undefined,
    openPreviewDb: async () => ({}),
    previewSqlitePath: () => '/preview.sqlite',
    previewSqliteSchemaVersion: 1,
    collectPreviewMaintenanceDirs: async () => [],
    normalizePathForCacheCompare: (value) => value,
    runTaskMaintenance: async () => ({ resetRunning: 0, removedCompleted: 0, removedFailed: 0, removedErrors: 0 })
  })

  await Promise.all([
    runtime.createDatabaseBackup('first'),
    runtime.createDatabaseBackup('second')
  ])
  assert(maxActiveBackups === 1, 'database backup operations overlapped')
  assert(backupOrder.join(',') === 'start:first,end:first,start:second,end:second', 'database operations did not preserve request order')

  const missing = await runtime.restoreLatestApplicationDatabase('library')
  assert(missing.ok === false, 'missing-backup restore should fail')
  assert(quarantineCalls === 0, 'the current database was moved before a valid backup was confirmed')

  restoreMode = 'valid'
  const restored = await runtime.restoreLatestApplicationDatabase('library')
  assert(restored.ok === true, 'valid restore should succeed')
  assert(quarantineCalls === 1, 'the current database should be quarantined only after backup validation')
}

runBehaviorChecks()
  .then(() => console.log('[diagnostics:database-maintenance-serialization] ok'))
  .catch((error) => {
    console.error(`[diagnostics:database-maintenance-serialization] ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  })
