import { resolve } from 'node:path'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import type { PreviewCacheStorage } from './previewRuntimeTypes'
import type { PreviewCacheSharedPresenceStatus } from './previewCacheSharedPresenceRuntime'

export type PreviewCacheSharedPresenceIndexRuntime = {
  getSharedPresenceIndex: (storage: PreviewCacheStorage, previewKey: string) => Promise<PreviewCacheSharedPresenceStatus | null>
  rememberSharedPresenceIndex: (storage: PreviewCacheStorage, previewKey: string, status: PreviewCacheSharedPresenceStatus) => Promise<void>
  forgetSharedPresenceIndex: (storage: PreviewCacheStorage, previewKey: string) => Promise<void>
  snapshotStats: () => { hit: number; miss: number; written: number; forgotten: number; expired: number; errors: number }
}

export type PreviewCacheSharedPresenceIndexRuntimeOptions = {
  appendStartupLog: (message: string) => void
  openPreviewDb: () => Promise<any>
}

const DEFAULT_OK_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_MISSING_TTL_MS = 30 * 60 * 1000

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function okTtlMs(): number {
  return parseEnvInt('HFM_PREVIEW_SHARED_PRESENCE_INDEX_OK_TTL_MS', DEFAULT_OK_TTL_MS, 1000, 7 * 24 * 60 * 60 * 1000)
}

function missingTtlMs(): number {
  return parseEnvInt('HFM_PREVIEW_SHARED_PRESENCE_INDEX_MISSING_TTL_MS', DEFAULT_MISSING_TTL_MS, 1000, 24 * 60 * 60 * 1000)
}

function storageKey(storage: PreviewCacheStorage): string {
  return normalizePathForCacheCompare(resolve(String(storage.rootPath || storage.indexDbPath || storage.dir || 'shared-preview-cache')))
}

function expiresAtForStatus(status: PreviewCacheSharedPresenceStatus): number {
  return Date.now() + (status === 'ok' ? okTtlMs() : missingTtlMs())
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createPreviewCacheSharedPresenceIndexRuntime(options: PreviewCacheSharedPresenceIndexRuntimeOptions): PreviewCacheSharedPresenceIndexRuntime {
  let initialized = false
  const stats = { hit: 0, miss: 0, written: 0, forgotten: 0, expired: 0, errors: 0 }

  async function ensureSchema(db: any): Promise<void> {
    if (initialized) return
    db.exec(`
      CREATE TABLE IF NOT EXISTS preview_shared_presence (
        storage_key TEXT NOT NULL,
        preview_key TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(storage_key, preview_key)
      );
      CREATE INDEX IF NOT EXISTS idx_preview_shared_presence_expires ON preview_shared_presence(expires_at);
      CREATE INDEX IF NOT EXISTS idx_preview_shared_presence_status ON preview_shared_presence(status);
    `)
    initialized = true
  }

  async function getSharedPresenceIndex(storage: PreviewCacheStorage, previewKey: string): Promise<PreviewCacheSharedPresenceStatus | null> {
    try {
      const db = await options.openPreviewDb()
      await ensureSchema(db)
      const key = storageKey(storage)
      const row = db.prepare('SELECT status, expires_at FROM preview_shared_presence WHERE storage_key = ? AND preview_key = ?').get(key, previewKey) as { status?: string; expires_at?: number } | undefined
      if (!row || (row.status !== 'ok' && row.status !== 'missing')) {
        stats.miss += 1
        return null
      }
      if (Number(row.expires_at || 0) <= Date.now()) {
        db.prepare('DELETE FROM preview_shared_presence WHERE storage_key = ? AND preview_key = ?').run(key, previewKey)
        stats.expired += 1
        return null
      }
      stats.hit += 1
      return row.status
    } catch (error) {
      stats.errors += 1
      options.appendStartupLog(`preview shared presence index read failed: ${errorMessage(error)}`)
      return null
    }
  }

  async function rememberSharedPresenceIndex(storage: PreviewCacheStorage, previewKey: string, status: PreviewCacheSharedPresenceStatus): Promise<void> {
    try {
      const db = await options.openPreviewDb()
      await ensureSchema(db)
      db.prepare(`
        INSERT INTO preview_shared_presence (storage_key, preview_key, status, expires_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(storage_key, preview_key) DO UPDATE SET
          status = excluded.status,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `).run(storageKey(storage), previewKey, status, expiresAtForStatus(status), new Date().toISOString())
      stats.written += 1
    } catch (error) {
      stats.errors += 1
      options.appendStartupLog(`preview shared presence index write failed: ${errorMessage(error)}`)
    }
  }

  async function forgetSharedPresenceIndex(storage: PreviewCacheStorage, previewKey: string): Promise<void> {
    try {
      const db = await options.openPreviewDb()
      await ensureSchema(db)
      db.prepare('DELETE FROM preview_shared_presence WHERE storage_key = ? AND preview_key = ?').run(storageKey(storage), previewKey)
      stats.forgotten += 1
    } catch (error) {
      stats.errors += 1
      options.appendStartupLog(`preview shared presence index delete failed: ${errorMessage(error)}`)
    }
  }

  function snapshotStats(): { hit: number; miss: number; written: number; forgotten: number; expired: number; errors: number } {
    return { ...stats }
  }

  return {
    getSharedPresenceIndex,
    rememberSharedPresenceIndex,
    forgetSharedPresenceIndex,
    snapshotStats,
  }
}
