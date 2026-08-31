import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import { ROOT_INDEX_DB_SCHEMA_VERSION } from '../../cache/constants'
import { sqliteEnsureColumn, sqliteEntryFileIdentity, sqliteNextOpstamp, sqliteRowToScanEntry } from './rootIndexSqliteRuntime'
import type { FontScanCacheEntry, FontScanCacheFile, RootIndexRuntimeDeps, RootIndexStorage } from './rootIndexTypes'

export function createRootIndexDatabaseRuntime(deps: RootIndexRuntimeDeps) {
  function initializeRootIndexDb(db: any, rootPath: string, storage: RootIndexStorage, touchMeta = true): void {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        relative_path TEXT PRIMARY KEY,
        cache_key TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        modified_at REAL NOT NULL,
        created_at REAL,
        status TEXT NOT NULL,
        font_json TEXT,
        message TEXT,
        cached_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1,
        opstamp INTEGER NOT NULL DEFAULT 0,
        file_identity TEXT,
        content_hash TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
      CREATE INDEX IF NOT EXISTS idx_entries_modified ON entries(modified_at);
      CREATE TABLE IF NOT EXISTS index_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        opstamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        previous_relative_path TEXT,
        font_id TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_index_events_opstamp ON index_events(opstamp);
      CREATE INDEX IF NOT EXISTS idx_index_events_path ON index_events(relative_path);
      CREATE TABLE IF NOT EXISTS directories (
        relative_path TEXT PRIMARY KEY,
        modified_at REAL NOT NULL,
        file_count INTEGER NOT NULL,
        dir_count INTEGER NOT NULL,
        scanned_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_directories_modified ON directories(modified_at);
    `)

    sqliteEnsureColumn(db, 'entries', 'is_deleted', 'ALTER TABLE entries ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0')
    sqliteEnsureColumn(db, 'entries', 'deleted_at', 'ALTER TABLE entries ADD COLUMN deleted_at TEXT')
    sqliteEnsureColumn(db, 'entries', 'revision', 'ALTER TABLE entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1')
    sqliteEnsureColumn(db, 'entries', 'opstamp', 'ALTER TABLE entries ADD COLUMN opstamp INTEGER NOT NULL DEFAULT 0')
    sqliteEnsureColumn(db, 'entries', 'file_identity', 'ALTER TABLE entries ADD COLUMN file_identity TEXT')
    sqliteEnsureColumn(db, 'entries', 'content_hash', 'ALTER TABLE entries ADD COLUMN content_hash TEXT')

    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entries_deleted ON entries(is_deleted);
        CREATE INDEX IF NOT EXISTS idx_entries_identity ON entries(file_identity);
      `)
    } catch (error) {
      deps.appendStartupLog(`root index migration index creation failed: ${error instanceof Error ? error.message : String(error)}`)
    }

    if (touchMeta) {
      const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      setMeta.run('schema_version', String(ROOT_INDEX_DB_SCHEMA_VERSION))
      setMeta.run('schemaVersion', String(ROOT_INDEX_DB_SCHEMA_VERSION))
      setMeta.run('index_version', String(deps.fontScanCacheVersion))
      setMeta.run('cacheVersion', String(deps.fontScanCacheVersion))
      setMeta.run('scriptDetectionVersion', String(deps.scriptDetectionVersion))
      setMeta.run('rootPath', rootPath)
      setMeta.run('storage', storage)
      setMeta.run('updatedAt', new Date().toISOString())
    }
  }

  async function openRootIndexDb(filePath: string, rootPath: string, storage: RootIndexStorage, touchMeta = true): Promise<any> {
    await fsp.mkdir(dirname(filePath), { recursive: true })
    const db = deps.openStableSqliteDb(filePath, `root-index:${storage}`)
    initializeRootIndexDb(db, rootPath, storage, touchMeta)
    return db
  }

  async function readRootIndexSqliteFile(filePath: string, rootPath: string, storage: RootIndexStorage): Promise<FontScanCacheFile> {
    if (!(await deps.exists(filePath))) return { version: deps.fontScanCacheVersion, entries: {} }

    const db = await openRootIndexDb(filePath, rootPath, storage, false)
    try {
      const rows = db.prepare(`
        SELECT relative_path, cache_key, file_size, modified_at, created_at, status, font_json, message, content_hash, cached_at
        FROM entries
        WHERE COALESCE(is_deleted, 0) = 0 AND status <> 'deleted'
        ORDER BY relative_path
      `).all() as Array<{ relative_path: string; cache_key: string; file_size: number; modified_at: number; created_at?: number; status: string; font_json?: string; message?: string; content_hash?: string; cached_at: string }>
      const entries: Record<string, FontScanCacheEntry> = {}
      for (const row of rows) entries[row.relative_path] = sqliteRowToScanEntry(row)
      return { version: deps.fontScanCacheVersion, entries }
    } finally {
      deps.closeSqliteDb(db)
    }
  }

  function writeFullRootIndexToOpenDb(db: any, cache: FontScanCacheFile): void {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec('DELETE FROM entries')
      const insert = db.prepare(`
        INSERT OR REPLACE INTO entries (
          relative_path, cache_key, file_size, modified_at, created_at, status, font_json, message, cached_at,
          is_deleted, deleted_at, revision, opstamp, file_identity, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?, ?, ?)
      `)
      for (const [relativePath, entry] of Object.entries(cache.entries || {})) {
        insert.run(
          relativePath,
          entry.cacheKey,
          Math.round(entry.fileSize || 0),
          Number(entry.modifiedAt || 0),
          entry.createdAt === undefined ? null : Number(entry.createdAt),
          entry.status,
          entry.font ? JSON.stringify(entry.font) : null,
          entry.message || null,
          entry.cachedAt || new Date().toISOString(),
          sqliteNextOpstamp(db),
          sqliteEntryFileIdentity(relativePath, entry),
          entry.contentHash || null
        )
      }
      const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
      setMeta.run('updatedAt', new Date().toISOString())
      setMeta.run('last_update.index_rebuild', new Date().toISOString())
      setMeta.run('last_update.entry_state_check', new Date().toISOString())
      setMeta.run('fileCount', String(Object.keys(cache.entries || {}).length))
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }
  }

  async function saveRootIndexSqliteFileDirect(filePath: string, rootPath: string, storage: RootIndexStorage, cache: FontScanCacheFile): Promise<void> {
    const db = await openRootIndexDb(filePath, rootPath, storage)
    try {
      writeFullRootIndexToOpenDb(db, cache)
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch { /* ignore */ }
    } finally {
      deps.closeSqliteDb(db)
    }
  }

  return {
    initializeRootIndexDb,
    openRootIndexDb,
    readRootIndexSqliteFile,
    writeFullRootIndexToOpenDb,
    saveRootIndexSqliteFileDirect,
  }
}
