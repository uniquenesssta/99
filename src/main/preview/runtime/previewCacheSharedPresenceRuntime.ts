import { resolve } from 'node:path'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import type { PreviewCacheStorage } from './previewRuntimeTypes'

export type PreviewCacheSharedPresenceStatus = 'ok' | 'missing'

export type PreviewCacheSharedPresenceRuntime = {
  getSharedPresence: (storage: PreviewCacheStorage, previewKey: string) => PreviewCacheSharedPresenceStatus | null
  rememberSharedPresence: (storage: PreviewCacheStorage, previewKey: string, status: PreviewCacheSharedPresenceStatus) => void
  forgetSharedPresence: (storage: PreviewCacheStorage, previewKey: string) => void
  rememberSharedPresenceBatch: (storage: PreviewCacheStorage, rows: Array<{ previewKey: string; ok: boolean }>) => void
  snapshotStats: () => { ok: number; missing: number; evicted: number }
}

const DEFAULT_OK_TTL_MS = 30 * 60 * 1000
const DEFAULT_MISSING_TTL_MS = 10 * 60 * 1000
const DEFAULT_LIMIT = 20000

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function okTtlMs(): number {
  return parseEnvInt('HFM_PREVIEW_SHARED_PRESENCE_OK_TTL_MS', DEFAULT_OK_TTL_MS, 1000, 24 * 60 * 60 * 1000)
}

function missingTtlMs(): number {
  return parseEnvInt('HFM_PREVIEW_SHARED_PRESENCE_MISSING_TTL_MS', DEFAULT_MISSING_TTL_MS, 1000, 24 * 60 * 60 * 1000)
}

function cacheLimit(): number {
  return parseEnvInt('HFM_PREVIEW_SHARED_PRESENCE_LIMIT', DEFAULT_LIMIT, 1000, 500000)
}

function storageKey(storage: PreviewCacheStorage): string {
  return normalizePathForCacheCompare(resolve(String(storage.rootPath || storage.indexDbPath || storage.dir || 'shared-preview-cache')))
}

function entryKey(storage: PreviewCacheStorage, previewKey: string): string {
  return `${storageKey(storage)}:${previewKey}`
}

type PresenceEntry = {
  status: PreviewCacheSharedPresenceStatus
  expiresAt: number
}

export function createPreviewCacheSharedPresenceRuntime(): PreviewCacheSharedPresenceRuntime {
  const entries = new Map<string, PresenceEntry>()
  const stats = { ok: 0, missing: 0, evicted: 0 }

  function trim(): void {
    const limit = cacheLimit()
    if (entries.size <= limit) return
    const now = Date.now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now || entries.size > Math.floor(limit * 0.8)) {
        entries.delete(key)
        stats.evicted += 1
      }
      if (entries.size <= Math.floor(limit * 0.8)) break
    }
  }

  function getSharedPresence(storage: PreviewCacheStorage, previewKey: string): PreviewCacheSharedPresenceStatus | null {
    const key = entryKey(storage, previewKey)
    const entry = entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= Date.now()) {
      entries.delete(key)
      return null
    }
    return entry.status
  }

  function rememberSharedPresence(storage: PreviewCacheStorage, previewKey: string, status: PreviewCacheSharedPresenceStatus): void {
    entries.set(entryKey(storage, previewKey), {
      status,
      expiresAt: Date.now() + (status === 'ok' ? okTtlMs() : missingTtlMs()),
    })
    stats[status] += 1
    trim()
  }

  function forgetSharedPresence(storage: PreviewCacheStorage, previewKey: string): void {
    entries.delete(entryKey(storage, previewKey))
  }

  function rememberSharedPresenceBatch(storage: PreviewCacheStorage, rows: Array<{ previewKey: string; ok: boolean }>): void {
    for (const row of rows) rememberSharedPresence(storage, row.previewKey, row.ok ? 'ok' : 'missing')
  }

  function snapshotStats(): { ok: number; missing: number; evicted: number } {
    return { ...stats }
  }

  return {
    getSharedPresence,
    rememberSharedPresence,
    forgetSharedPresence,
    rememberSharedPresenceBatch,
    snapshotStats,
  }
}
