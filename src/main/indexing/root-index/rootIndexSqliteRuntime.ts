import crypto from 'node:crypto'
import type { FontItem } from '../../../shared/types'
import type { FontScanCacheEntry } from './rootIndexTypes'

export function sha1(value: string): string {
  return crypto.createHash('sha1').update(value).digest('hex')
}

export function parseSqliteJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function sqliteEnsureColumn(db: any, tableName: string, columnName: string, addSql: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>
  if (columns.some((column) => column.name === columnName)) return
  try { db.exec(addSql) } catch { /* already exists or older sqlite restriction */ }
}

export function sqliteGetMetaNumber(db: any, key: string, fallback = 0): number {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value?: string } | undefined
    const value = Number(row?.value)
    return Number.isFinite(value) ? value : fallback
  } catch {
    return fallback
  }
}

export function sqliteSetMeta(db: any, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value)
}

export function sqliteNextOpstamp(db: any): number {
  const next = sqliteGetMetaNumber(db, 'index_opstamp', 0) + 1
  sqliteSetMeta(db, 'index_opstamp', String(next))
  return next
}

export function sqliteInsertIndexEvent(db: any, eventType: string, relativePath: string, previousRelativePath: string | null, fontId: string | null, payload: unknown): void {
  const opstamp = sqliteNextOpstamp(db)
  db.prepare(`
    INSERT INTO index_events (opstamp, event_type, relative_path, previous_relative_path, font_id, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(opstamp, eventType, relativePath, previousRelativePath, fontId, JSON.stringify(payload || {}), new Date().toISOString())
}

export function sqliteEntryFileIdentity(relativePath: string, entry: FontScanCacheEntry): string {
  const fontId = entry.font?.id || ''
  return sha1([relativePath, entry.cacheKey, entry.fileSize, Math.round(entry.modifiedAt), entry.contentHash || '', fontId].join('|'))
}

export function sqliteRowToScanEntry(row: { relative_path: string; cache_key: string; file_size: number; modified_at: number; created_at?: number; status: string; font_json?: string; message?: string; content_hash?: string; cached_at: string }): FontScanCacheEntry {
  return {
    path: row.relative_path,
    cacheKey: row.cache_key,
    fileSize: Number(row.file_size || 0),
    modifiedAt: Number(row.modified_at || 0),
    createdAt: row.created_at === undefined || row.created_at === null ? undefined : Number(row.created_at),
    status: row.status === 'bad' ? 'bad' : 'ok',
    font: parseSqliteJson<FontItem | undefined>(row.font_json, undefined),
    message: row.message || undefined,
    contentHash: row.content_hash || undefined,
    cachedAt: row.cached_at
  }
}
