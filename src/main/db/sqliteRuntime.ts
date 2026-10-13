import { SqliteIntegrityError } from './sqliteRecoveryPolicy'
import { assertNoSqliteRestoreIntent, restoreSqliteWithPreservation, SqliteRestoreFailure } from './sqliteRestorePreservationRuntime'
import { rethrowSharedIoProcessError } from '../path/sharedIoProcessRuntime'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import type { createRequire } from 'node:module'
import { basename,join } from 'node:path'

type NodeRequire = ReturnType<typeof createRequire>

export type ApplicationDatabaseLabel = 'library' | 'tasks' | 'preview' | 'kvs' | 'events' | 'hash' | 'metrics'
export type SqliteRestoreResult = { ok: boolean; backupPath?: string; preservationPath?: string; message: string }

interface SqliteRuntimeOptions {
  appName: string
  nodeRequire: NodeRequire
  normalizePath: (filePath: string) => string
  sqliteSidecarPaths: (filePath: string) => string[]
  appendLog: (message: string) => void
  exists: (filePath: string) => Promise<boolean>
  backupsRootPath: () => string
  corruptDatabasesRootPath: () => string
  applicationDatabasePaths: () => string[]
  quickCheckIntervalMs: number
  fastOpenSharedCacheDbs: boolean
  verboseSqliteLogs: boolean
  busyTimeoutMs: number
  mmapSizeBytes: number
  corruptRetentionCount: number
}

function safeRecoveryFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'database'
}

function timestampForFileName(date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
}

function isSharedCacheSqlitePath(normalizePath: (filePath: string) => string, filePath: string): boolean {
  const normalized = normalizePath(filePath || '').replace(/\\/g, '/')
  return normalized.includes('/.hfm-cache/') || normalized.includes('/.hfm-preview-cache/')
}

export function createSqliteRuntime(options: SqliteRuntimeOptions): {
  loadBetterSqlite3Factory: () => any
  closeSqliteDb: (db: any) => void
  recoveryMessage: (error: unknown) => string
  clearSqliteOpenCaches: (filePath: string) => void
  sqliteQuickCheck: (db: any, label: string, filePath: string, force?: boolean) => void
  openStableSqliteDb: (filePath: string, label: string) => any
  quarantineSqliteFiles: (filePath: string, label: string, reason: string, quarantineRoot?: string) => Promise<string | undefined>
  assertSqliteFileHealthy: (filePath: string, label: string) => void
  restoreLatestDatabaseBackupForLabel: (label: string, targetPath: string, restoreOptions?: { beforeReplace?: (backupPath: string) => Promise<void> }) => Promise<SqliteRestoreResult>
  openRecoverableApplicationSqliteDb: (filePath: string, label: ApplicationDatabaseLabel) => Promise<any>
} {
  let betterSqlite3Factory: any | null = null
  const sqliteQuickCheckAt = new Map<string, number>()
  const sqliteOpenedLogKeys = new Set<string>()
  const sqliteQuickCheckFastOpenSkippedKeys = new Set<string>()
  const openHandles = new Map<string, Set<any>>()
  const restorePaths = new Set<string>()
  const manualRestoreTargets = new Set<string>()

  const sqliteLogKey = (filePath: string): string => options.normalizePath(filePath || '')

  const loadBetterSqlite3Factory = (): any => {
    if (betterSqlite3Factory) return betterSqlite3Factory
    try {
      const loaded = options.nodeRequire('better-sqlite3')
      betterSqlite3Factory = loaded?.default || loaded
      return betterSqlite3Factory
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`无法加载稳定 SQLite 引擎 better-sqlite3。请先执行 npm install，并确保 Electron 原生模块已重建。详情：${detail}`)
    }
  }

  const closeSqliteDb = (db: any): void => {
    if (!db) return
    try {
      db.close?.()
      for (const [key, handles] of openHandles) {
        handles.delete(db)
        if (!handles.size) openHandles.delete(key)
      }
    } catch { /* A failed close remains tracked and blocks destructive restore. */ }
  }

  const assertSqliteHandlesClosed = (filePath: string): void => {
    const handles = openHandles.get(sqliteLogKey(filePath))
    if (!handles) return
    for (const db of handles) {
      if (db.open === false) handles.delete(db)
      else throw new Error(`数据库连接尚未关闭，无法安全恢复：${filePath}`)
    }
    if (!handles.size) openHandles.delete(sqliteLogKey(filePath))
  }

  const recoveryMessage = (error: unknown): string => error instanceof Error ? error.message : String(error)

  const clearSqliteOpenCaches = (filePath: string): void => {
    const key = sqliteLogKey(filePath)
    if (!key) return
    sqliteQuickCheckAt.delete(key)
    sqliteOpenedLogKeys.delete(key)
  }

  const sqlitePragma = (db: any, sql: string, label: string): void => {
    try {
      db.exec(`PRAGMA ${sql};`)
    } catch (error) {
      options.appendLog(`sqlite pragma failed: ${label}, ${sql}, ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const shouldSkipSqliteQuickCheckForFastOpen = (label: string, filePath: string, force: boolean): boolean => {
    if (force || !options.fastOpenSharedCacheDbs) return false
    if (!isSharedCacheSqlitePath(options.normalizePath, filePath)) return false
    return label.startsWith('root-index')
      || label.startsWith('machine-install')
      || label.startsWith('preview:')
      || label === 'preview-stats'
  }

  const sqliteQuickCheck = (db: any, label: string, filePath: string, force = false): void => {
    const key = sqliteLogKey(filePath)
    const now = Date.now()
    const checkedAt = key ? sqliteQuickCheckAt.get(key) : undefined
    if (!force && checkedAt && now - checkedAt < options.quickCheckIntervalMs) return
    if (shouldSkipSqliteQuickCheckForFastOpen(label, filePath, force)) {
      if (key) sqliteQuickCheckAt.set(key, now)
      const skipKey = key ? `quick-skip:${key}` : ''
      if (options.verboseSqliteLogs || !skipKey || !sqliteQuickCheckFastOpenSkippedKeys.has(skipKey)) {
        options.appendLog(`sqlite quick_check skipped fast-open shared cache: ${label}, ${filePath}`)
        if (skipKey) sqliteQuickCheckFastOpenSkippedKeys.add(skipKey)
      }
      return
    }

    try {
      const row = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined
      const result = row ? String(Object.values(row)[0] || '') : ''
      if (!result || result.toLowerCase() !== 'ok') throw new SqliteIntegrityError(result || 'quick_check returned no result')
      if (key) sqliteQuickCheckAt.set(key, now)
      if (options.verboseSqliteLogs || !key || !sqliteOpenedLogKeys.has(`quick:${key}`)) {
        options.appendLog(`sqlite quick_check ok: ${label}, ${filePath}`)
        if (key) sqliteOpenedLogKeys.add(`quick:${key}`)
      }
    } catch (error) {
      clearSqliteOpenCaches(filePath)
      throw new Error(`SQLite 数据库健康检查失败：${label}, ${filePath}, ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  const configureStableSqliteDb = (db: any, label: string, filePath: string): void => {
    sqlitePragma(db, `busy_timeout = ${options.busyTimeoutMs}`, label)
    sqlitePragma(db, 'journal_mode = WAL', label)
    sqlitePragma(db, 'synchronous = NORMAL', label)
    sqlitePragma(db, 'temp_store = MEMORY', label)
    sqlitePragma(db, 'foreign_keys = ON', label)
    sqlitePragma(db, `mmap_size = ${options.mmapSizeBytes}`, label)
    sqliteQuickCheck(db, label, filePath)
  }

  const openStableSqliteDb = (filePath: string, label: string): any => {
    const key = sqliteLogKey(filePath)
    if (restorePaths.has(key)) throw new Error(`数据库正在恢复或等待人工恢复，暂不能打开：${filePath}`)
    if (manualRestoreTargets.has(key) || options.applicationDatabasePaths?.().some(path => sqliteLogKey(path) === key)) {
      assertNoSqliteRestoreIntent(filePath)
    }
    const Database = loadBetterSqlite3Factory()
    const db = new Database(filePath)
    const handles = openHandles.get(key) || new Set<any>()
    handles.add(db)
    openHandles.set(key, handles)
    try {
      // Labels describe callers, not ownership. Every handle for this normalized
      // path blocks replacement, including readers opened under an alias label.
      // Hook direct close() as well as closeSqliteDb(), so closed derived-store
      // handles cannot accumulate in the registry. A thrown close stays tracked.
      const close = db.close
      db.close = function (this: any, ...args: any[]) {
        const result = close.apply(this, args)
        if (this === db) {
          handles.delete(db)
          if (!handles.size && openHandles.get(key) === handles) openHandles.delete(key)
        }
        return result
      }
      configureStableSqliteDb(db, label, filePath)
      if (options.verboseSqliteLogs || !key || !sqliteOpenedLogKeys.has(`open:${key}`)) {
        options.appendLog(`sqlite opened with better-sqlite3: ${label}, ${filePath}`)
        if (key) sqliteOpenedLogKeys.add(`open:${key}`)
      }
      return db
    } catch (error) {
      closeSqliteDb(db)
      throw error
    }
  }

  const pruneOldCorruptDatabaseQuarantines = async (): Promise<void> => {
    try {
      await fsp.mkdir(options.corruptDatabasesRootPath(), { recursive: true })
      const entries = await fsp.readdir(options.corruptDatabasesRootPath(), { withFileTypes: true })
      const dirs = entries
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .reverse()

      for (const name of dirs.slice(options.corruptRetentionCount)) {
        await fsp.rm(join(options.corruptDatabasesRootPath(), name), { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (error) {
      options.appendLog(`database corrupt retention skipped: ${recoveryMessage(error)}`)
    }
  }

  const quarantineSqliteFiles = async (filePath: string, label: string, reason: string, quarantineRoot = options.corruptDatabasesRootPath()): Promise<string | undefined> => {
    const existsAny = await Promise.all(options.sqliteSidecarPaths(filePath).map((item) => options.exists(item))).then((items) => items.some(Boolean))
    if (!existsAny) return undefined
    clearSqliteOpenCaches(filePath)

    const quarantineDir = join(quarantineRoot, `${timestampForFileName(new Date())}-${safeRecoveryFileName(label)}`)
    await fsp.mkdir(quarantineDir, { recursive: true })

    const moved: string[] = []
    for (const source of options.sqliteSidecarPaths(filePath)) {
      if (!(await options.exists(source))) continue
      const suffix = source === filePath ? '' : source.slice(filePath.length)
      const target = join(quarantineDir, `${basename(filePath)}${suffix}`)
      try {
        await fsp.rename(source, target)
        moved.push(target)
      } catch (error) {
        rethrowSharedIoProcessError(error)
        try {
          await fsp.copyFile(source, target)
          await fsp.rm(source, { force: true })
          moved.push(target)
        } catch (error) {
          rethrowSharedIoProcessError(error)
          options.appendLog(`sqlite quarantine file skipped: ${source} ${recoveryMessage(error)}`)
        }
      }
    }

    await fsp.writeFile(join(quarantineDir, 'recovery-manifest.json'), JSON.stringify({
      app: options.appName,
      label,
      sourcePath: filePath,
      reason,
      moved,
      createdAt: new Date().toISOString()
    }, null, 2), 'utf-8').catch(() => undefined)
    await pruneOldCorruptDatabaseQuarantines()
    options.appendLog(`sqlite corrupt database quarantined: ${label}, ${filePath} -> ${quarantineDir}`)
    return quarantineDir
  }

  const findLatestDatabaseBackupFile = async (label: string): Promise<string | null> => {
    try {
      const entries = await fsp.readdir(options.backupsRootPath(), { withFileTypes: true })
      const backupDirs = entries
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(entry.name))
        .map((entry) => join(options.backupsRootPath(), entry.name))
        .sort()
        .reverse()

      for (const dirPath of backupDirs) {
        const candidate = join(dirPath, `${label}.sqlite`)
        if (await options.exists(candidate)) return candidate
      }
    } catch {
      // no backup dir yet
    }
    return null
  }

  const assertSqliteFileHealthy = (filePath: string, label: string): void => {
    const Database = loadBetterSqlite3Factory()
    const db = new Database(filePath, { readonly: true, fileMustExist: true })
    let failed = false
    try {
      sqliteQuickCheck(db, label, filePath, true)
    } catch (error) {
      failed = true
      throw error
    } finally {
      // A leaked validation handle is not a successful validation receipt.
      try { db.close() } catch (error) { if (!failed) throw error }
    }
  }

  const restoreLatestDatabaseBackupForLabel = async (
    label: string,
    targetPath: string,
    restoreOptions: { beforeReplace?: (backupPath: string) => Promise<void> } = {},
  ): Promise<SqliteRestoreResult> => {
    const key = sqliteLogKey(targetPath)
    if (restorePaths.has(key)) return { ok: false, message: '数据库正在恢复或等待人工恢复，不能重复替换。' }
    manualRestoreTargets.add(key)
    try { assertNoSqliteRestoreIntent(targetPath) }
    catch (error) { return { ok: false, message: recoveryMessage(error) } }
    restorePaths.add(key)
    let releaseGate = true
    try {
      const backupPath = await findLatestDatabaseBackupFile(label)
      if (!backupPath) return { ok: false, message: '没有可用备份。' }

      try {
        assertSqliteFileHealthy(backupPath, `${label}:backup-source`)
      } catch (error) {
        return {
          ok: false,
          backupPath,
          message: `最近备份无法通过健康检查：${recoveryMessage(error)}`,
        }
      }

      try {
        const receipt = await restoreSqliteWithPreservation({ targetPath, backupPath,
          preservationRoot: options.corruptDatabasesRootPath(),
          beforePreserve: async () => { await restoreOptions.beforeReplace?.(backupPath) },
          assertClosed: () => assertSqliteHandlesClosed(targetPath),
          assertHealthy: path => assertSqliteFileHealthy(path, `${label}:restore-candidate`),
          log: options.appendLog,
        })
        clearSqliteOpenCaches(targetPath)
        try { options.appendLog(`sqlite restored from backup: ${label}, ${backupPath} -> ${targetPath}, preserved=${receipt.directory}`) } catch { /* storage result is authoritative */ }
        return { ok: true, backupPath, preservationPath: receipt.directory, message: `已从最近备份恢复。原数据库完整保全于：${receipt.directory}` }
      } catch (error) {
        if (error instanceof SqliteRestoreFailure && !error.rollbackComplete) releaseGate = false
        return { ok: false, backupPath, preservationPath: error instanceof SqliteRestoreFailure ? error.preservationPath : undefined,
          message: recoveryMessage(error) }
      }
    } finally { if (releaseGate) restorePaths.delete(key) }
  }

  const openRecoverableApplicationSqliteDb = async (filePath: string, label: ApplicationDatabaseLabel): Promise<any> => {
    // Replacement requires an owning store to build/validate a candidate. The
    // generic connection layer cannot know whether a file contains user intent.
    // Root and merged indexes have their own snapshot recovery owners.
    return openStableSqliteDb(filePath, label)
  }

  return {
    loadBetterSqlite3Factory,
    closeSqliteDb,
    recoveryMessage,
    clearSqliteOpenCaches,
    sqliteQuickCheck,
    openStableSqliteDb,
    quarantineSqliteFiles,
    assertSqliteFileHealthy,
    restoreLatestDatabaseBackupForLabel,
    openRecoverableApplicationSqliteDb
  }
}
