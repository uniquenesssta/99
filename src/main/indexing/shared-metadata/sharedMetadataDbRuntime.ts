import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import { sharedMetadataDbPathForRoot } from './sharedMetadataPathsRuntime'

export interface SharedMetadataDbRuntimeDeps {
  openStableSqliteDb: (filePath: string, label: string) => any
  appendStartupLog: (message: string) => void
}

export function createSharedMetadataDbRuntime(deps: SharedMetadataDbRuntimeDeps) {
  function initializeSharedMetadataDb(db: any): void {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS font_metadata (
        font_id TEXT PRIMARY KEY,
        relative_path TEXT,
        path_key TEXT,
        tag_names_json TEXT NOT NULL DEFAULT '[]',
        favorite INTEGER NOT NULL DEFAULT 0,
        delete_protected INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        updated_by TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shared_metadata_relative_path ON font_metadata(relative_path);
      CREATE INDEX IF NOT EXISTS idx_shared_metadata_path_key ON font_metadata(path_key);
      CREATE TABLE IF NOT EXISTS metadata_events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        font_id TEXT,
        relative_path TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        writer_host TEXT,
        writer_pid INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_shared_metadata_events_created ON metadata_events(created_at);
      CREATE TABLE IF NOT EXISTS shared_tag_ops (
        op_id TEXT PRIMARY KEY,
        font_id TEXT NOT NULL,
        relative_path TEXT,
        path_key TEXT,
        action TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        base_revision INTEGER NOT NULL DEFAULT 0,
        next_revision INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        machine_id TEXT,
        writer_pid INTEGER,
        tombstone INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_font_tag ON shared_tag_ops(font_id, tag_name);
      CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_created ON shared_tag_ops(created_at);
      CREATE TABLE IF NOT EXISTS shared_tag_ops_archive (
        archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
        archived_at TEXT NOT NULL,
        archive_reason TEXT NOT NULL,
        source_table TEXT NOT NULL DEFAULT 'shared_tag_ops',
        op_id TEXT NOT NULL,
        font_id TEXT,
        relative_path TEXT,
        path_key TEXT,
        action TEXT,
        tag_name TEXT,
        base_revision INTEGER,
        next_revision INTEGER,
        created_at TEXT,
        machine_id TEXT,
        writer_pid INTEGER,
        tombstone INTEGER,
        payload_json TEXT NOT NULL,
        UNIQUE(source_table, op_id, archive_reason)
      );
      CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_archive_op ON shared_tag_ops_archive(op_id);
      CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_archive_reason ON shared_tag_ops_archive(archive_reason, archived_at);
    `)
    const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
    setMeta.run('schemaVersion', '3')
    setMeta.run('cacheType', 'shared-font-metadata')
  }

  async function openSharedMetadataDb(rootPath: string, touch = true): Promise<any> {
    const dbPath = sharedMetadataDbPathForRoot(rootPath)
    await fsp.mkdir(dirname(dbPath), { recursive: true })
    const db = deps.openStableSqliteDb(dbPath, 'shared-metadata')
    initializeSharedMetadataDb(db)
    if (touch) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('openedAt', new Date().toISOString())
    }
    return db
  }

  function readMeta(db: any, key: string): string {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
    return String(row?.value || '')
  }

  function writeMeta(db: any, key: string, value: string): void {
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
  }

  return {
    initializeSharedMetadataDb,
    openSharedMetadataDb,
    readMeta,
    writeMeta,
  }
}
