import type { CacheArchitectureRuntimeOptions } from './cacheArchitectureTypes'

function writeCacheMeta(db: any, options: CacheArchitectureRuntimeOptions, schemaVersion: number): void {
  options.setSqliteMeta(db, 'schemaVersion', String(schemaVersion))
  options.setSqliteMeta(db, 'cacheArchitectureVersion', String(options.cacheArchitectureVersion))
  options.setSqliteMeta(db, 'updatedAt', new Date().toISOString())
}

export function initializeKvsDb(db: any, options: CacheArchitectureRuntimeOptions): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS kvs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      value_type TEXT NOT NULL DEFAULT 'string',
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_kvs_updated ON kvs(updated_at);
  `)
  writeCacheMeta(db, options, options.kvsSqliteSchemaVersion)
}

export function initializeEventsDb(db: any, options: CacheArchitectureRuntimeOptions): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS index_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      root_path TEXT,
      event_type TEXT NOT NULL,
      font_id TEXT,
      relative_path TEXT,
      previous_relative_path TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON index_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_source_created ON index_events(source, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_font ON index_events(font_id);
  `)
  writeCacheMeta(db, options, options.eventsSqliteSchemaVersion)
}

export function initializeHashDb(db: any, options: CacheArchitectureRuntimeOptions): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_hashes (
      id TEXT PRIMARY KEY,
      font_id TEXT,
      path TEXT NOT NULL,
      quick_signature TEXT NOT NULL,
      exact_hash TEXT,
      file_size INTEGER NOT NULL DEFAULT 0,
      modified_at REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_file_hashes_font ON file_hashes(font_id);
    CREATE INDEX IF NOT EXISTS idx_file_hashes_signature ON file_hashes(quick_signature);
    CREATE TABLE IF NOT EXISTS duplicate_groups (
      group_key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      font_ids_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  writeCacheMeta(db, options, options.hashSqliteSchemaVersion)
}

export function initializeMetricsDb(db: any, options: CacheArchitectureRuntimeOptions): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS metric_snapshots (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_metric_snapshots_updated ON metric_snapshots(updated_at);
  `)
  writeCacheMeta(db, options, options.metricsSqliteSchemaVersion)
}
