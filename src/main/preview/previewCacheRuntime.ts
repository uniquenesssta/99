export type PreviewCacheIndexStatus = 'ok' | 'missing' | 'failed' | 'pending' | 'generating' | 'stale'

export type PreviewCacheRow = {
  preview_key: string
  font_id?: string | null
  source_path?: string | null
  root_path?: string | null
  relative_path: string
  output_path: string
  font_signature: string
  text_hash: string
  font_size: number
  width: number
  height: number
  storage: string
  status: PreviewCacheIndexStatus
  message?: string | null
  fail_count: number
  generated_at?: string | null
  accessed_at?: string | null
  updated_at: string
}

export type InitializePreviewDbDeps = {
  schemaVersion: number
  ensureSqliteColumn: (db: any, tableName: string, columnName: string, columnSql: string) => void
  setSqliteMeta: (db: any, key: string, value: string) => void
}

export function initializePreviewDbSchema(db: any, deps: InitializePreviewDbDeps): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS preview_cache (
      preview_key TEXT PRIMARY KEY,
      font_id TEXT,
      source_path TEXT,
      root_path TEXT,
      relative_path TEXT NOT NULL,
      output_path TEXT NOT NULL,
      font_signature TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      font_size INTEGER NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      storage TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      generated_at TEXT,
      accessed_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_preview_cache_relative_path ON preview_cache(relative_path);
    CREATE INDEX IF NOT EXISTS idx_preview_cache_source_path ON preview_cache(source_path);
    CREATE INDEX IF NOT EXISTS idx_preview_cache_root_path ON preview_cache(root_path);
    CREATE INDEX IF NOT EXISTS idx_preview_cache_status ON preview_cache(status);
    CREATE INDEX IF NOT EXISTS idx_preview_cache_accessed ON preview_cache(accessed_at);
    CREATE INDEX IF NOT EXISTS idx_preview_cache_storage ON preview_cache(storage);
  `)
  deps.ensureSqliteColumn(db, 'preview_cache', 'font_id', 'TEXT')
  deps.ensureSqliteColumn(db, 'preview_cache', 'source_path', 'TEXT')
  deps.ensureSqliteColumn(db, 'preview_cache', 'root_path', 'TEXT')
  deps.ensureSqliteColumn(db, 'preview_cache', 'message', 'TEXT')
  deps.ensureSqliteColumn(db, 'preview_cache', 'fail_count', 'INTEGER NOT NULL DEFAULT 0')
  deps.ensureSqliteColumn(db, 'preview_cache', 'generated_at', 'TEXT')
  deps.ensureSqliteColumn(db, 'preview_cache', 'accessed_at', 'TEXT')
  deps.ensureSqliteColumn(db, 'preview_cache', 'updated_at', 'TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP')
  deps.setSqliteMeta(db, 'schemaVersion', String(deps.schemaVersion))
  deps.setSqliteMeta(db, 'updatedAt', new Date().toISOString())
}

export function normalizePreviewCacheIndexStatus(value: unknown): PreviewCacheIndexStatus | null {
  return value === 'ok' || value === 'missing' || value === 'failed' || value === 'pending' || value === 'generating' || value === 'stale' ? value : null
}

export function legacyPreviewRowToParams(row: {
  preview_key?: string
  relative_path?: string
  output_path?: string
  font_signature?: string
  text_hash?: string
  font_size?: number
  width?: number
  height?: number
  storage?: string
  status?: string
  generated_at?: string
  message?: string | null
}, fallbackStorage?: string, fallbackRootPath?: string | null): PreviewCacheRow | null {
  const status = normalizePreviewCacheIndexStatus(row.status)
  if (!row.preview_key || !row.output_path || !status) return null
  const updatedAt = row.generated_at || new Date().toISOString()
  return {
    preview_key: row.preview_key,
    font_id: null,
    source_path: null,
    root_path: fallbackRootPath || null,
    relative_path: row.relative_path || '',
    output_path: row.output_path,
    font_signature: row.font_signature || '',
    text_hash: row.text_hash || '',
    font_size: Number(row.font_size || 0),
    width: Number(row.width || 0),
    height: Number(row.height || 0),
    storage: row.storage || fallbackStorage || 'local',
    status,
    message: row.message || null,
    fail_count: status === 'failed' ? 1 : 0,
    generated_at: row.generated_at || null,
    accessed_at: row.generated_at || null,
    updated_at: updatedAt
  }
}

export function upsertPreviewCacheRows(db: any, rows: PreviewCacheRow[]): number {
  if (!rows.length) return 0
  const upsert = db.prepare(`
    INSERT INTO preview_cache (
      preview_key, font_id, source_path, root_path, relative_path, output_path,
      font_signature, text_hash, font_size, width, height, storage, status,
      message, fail_count, generated_at, accessed_at, updated_at
    ) VALUES (
      @preview_key, @font_id, @source_path, @root_path, @relative_path, @output_path,
      @font_signature, @text_hash, @font_size, @width, @height, @storage, @status,
      @message, @fail_count, @generated_at, @accessed_at, @updated_at
    )
    ON CONFLICT(preview_key) DO UPDATE SET
      font_id = COALESCE(excluded.font_id, preview_cache.font_id),
      source_path = COALESCE(excluded.source_path, preview_cache.source_path),
      root_path = COALESCE(excluded.root_path, preview_cache.root_path),
      relative_path = excluded.relative_path,
      output_path = excluded.output_path,
      font_signature = excluded.font_signature,
      text_hash = excluded.text_hash,
      font_size = excluded.font_size,
      width = excluded.width,
      height = excluded.height,
      storage = excluded.storage,
      status = excluded.status,
      message = excluded.message,
      fail_count = MAX(preview_cache.fail_count, excluded.fail_count),
      generated_at = COALESCE(excluded.generated_at, preview_cache.generated_at),
      accessed_at = COALESCE(excluded.accessed_at, preview_cache.accessed_at),
      updated_at = excluded.updated_at
  `)
  const tx = db.transaction(() => {
    for (const row of rows) upsert.run(row)
  })
  tx()
  return rows.length
}
