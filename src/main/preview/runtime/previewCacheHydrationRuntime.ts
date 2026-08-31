import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PreviewCacheIndexStatus } from '../previewCacheRuntime'
import type { PreviewCacheStorage } from './previewRuntimeTypes'
import type { PreviewCacheSharedPresenceRuntime } from './previewCacheSharedPresenceRuntime'
import type { PreviewCacheSharedPresenceIndexRuntime } from './previewCachePresenceIndexRuntime'
import type { PreviewCacheMetaValidationResult } from './previewCacheMetaRuntime'

export type PreviewCacheHydrationRow = {
  id: string
  previewKey: string
  outputPath: string
  fontSignature: string
  textHash: string
  fontSize: number
  width: number
  height: number
  fontId?: string
  sourcePath?: string
}

export type PreviewCacheHydrationStats = {
  localHit: number
  sharedHit: number
  hydrated: number
  renderQueued: number
  sharedUnavailable: number
  deadlineDropped: number
  sharedNegativeHit: number
  sharedPresenceHit: number
  sharedPresenceIndexHit: number
  sharedMetaValidated: number
  sharedMetaMissing: number
  checksumMismatch: number
}

export type PreviewCacheHydrationRuntimeOptions = {
  appendStartupLog: (message: string) => void
  withIoDeadlineResult: <T>(label: string, operation: () => Promise<T>, timeoutMs: number) => Promise<{ ok: true; value: T; timedOut?: boolean } | { ok: false; error: unknown; timedOut?: boolean }>
  readPreviewCacheIndexStatus: (storage: PreviewCacheStorage, previewKey: string, outputPath: string) => Promise<PreviewCacheIndexStatus | null>
  writePreviewCacheIndex: (storage: PreviewCacheStorage, previewKey: string, data: { outputPath: string; fontSignature: string; textHash: string; fontSize: number; width: number; height: number; status: PreviewCacheIndexStatus; message?: string; fontId?: string; sourcePath?: string }) => Promise<void>
  previewCacheStorageToShared: (storage: PreviewCacheStorage) => PreviewCacheStorage | null
  ensureSharedAvailable: (rootPath: string) => Promise<boolean>
  sharedPresence?: PreviewCacheSharedPresenceRuntime
  sharedPresenceIndex?: PreviewCacheSharedPresenceIndexRuntime
  validateSharedPreviewCacheMeta?: (outputPath: string, row: PreviewCacheHydrationRow) => Promise<PreviewCacheMetaValidationResult>
  isStrictSharedMetaEnabled?: () => boolean
}

const DEFAULT_HYDRATE_MAX_IN_FLIGHT = 2
const DEFAULT_HYDRATE_TIMEOUT_MS = 2000
const DEFAULT_SHARED_NEGATIVE_TTL_MS = 10 * 60 * 1000
const DEFAULT_STATS_LOG_INTERVAL_MS = 10000

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function hydrateMaxInFlight(): number {
  return parseEnvInt('HFM_PREVIEW_HYDRATE_MAX_IN_FLIGHT', DEFAULT_HYDRATE_MAX_IN_FLIGHT, 1, 8)
}

function hydrateTimeoutMs(): number {
  return parseEnvInt('HFM_PREVIEW_HYDRATE_TIMEOUT_MS', DEFAULT_HYDRATE_TIMEOUT_MS, 200, 30000)
}

function sharedNegativeTtlMs(): number {
  return parseEnvInt('HFM_PREVIEW_SHARED_NEGATIVE_TTL_MS', DEFAULT_SHARED_NEGATIVE_TTL_MS, 1000, 60 * 60 * 1000)
}

function emptyStats(): PreviewCacheHydrationStats {
  return {
    localHit: 0,
    sharedHit: 0,
    hydrated: 0,
    renderQueued: 0,
    sharedUnavailable: 0,
    deadlineDropped: 0,
    sharedNegativeHit: 0,
    sharedPresenceHit: 0,
    sharedPresenceIndexHit: 0,
    sharedMetaValidated: 0,
    sharedMetaMissing: 0,
    checksumMismatch: 0,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath)
    return true
  } catch {
    return false
  }
}

export function createPreviewCacheHydrationRuntime(options: PreviewCacheHydrationRuntimeOptions) {
  const inFlight = new Map<string, Promise<boolean>>()
  const negative = new Map<string, number>()
  let stats = emptyStats()
  let lastStatsLogAt = 0

  function sharedKey(storage: PreviewCacheStorage, previewKey: string): string {
    return `${storage.rootPath || storage.indexDbPath || storage.dir}:${previewKey}`
  }

  function rememberSharedMiss(key: string): void {
    negative.set(key, Date.now() + sharedNegativeTtlMs())
    if (negative.size > 5000) {
      const now = Date.now()
      for (const [entryKey, expiresAt] of negative) {
        if (expiresAt <= now || negative.size > 4000) negative.delete(entryKey)
      }
    }
  }

  function hasSharedMiss(key: string): boolean {
    const expiresAt = negative.get(key) || 0
    if (expiresAt <= Date.now()) {
      negative.delete(key)
      return false
    }
    return true
  }

  function logStats(force = false): void {
    const now = Date.now()
    if (!force && now - lastStatsLogAt < DEFAULT_STATS_LOG_INTERVAL_MS) return
    const total = stats.localHit + stats.sharedHit + stats.hydrated + stats.renderQueued + stats.sharedUnavailable + stats.deadlineDropped + stats.sharedNegativeHit + stats.sharedPresenceHit + stats.sharedPresenceIndexHit + stats.sharedMetaValidated + stats.sharedMetaMissing + stats.checksumMismatch
    if (!total) return
    lastStatsLogAt = now
    options.appendStartupLog(`preview cache tier summary: localHit=${stats.localHit}, sharedHit=${stats.sharedHit}, hydrated=${stats.hydrated}, renderQueued=${stats.renderQueued}, sharedUnavailable=${stats.sharedUnavailable}, deadlineDropped=${stats.deadlineDropped}, sharedNegativeHit=${stats.sharedNegativeHit}, sharedPresenceHit=${stats.sharedPresenceHit}, sharedPresenceIndexHit=${stats.sharedPresenceIndexHit}, sharedMetaValidated=${stats.sharedMetaValidated}, sharedMetaMissing=${stats.sharedMetaMissing}, checksumMismatch=${stats.checksumMismatch}`)
    stats = emptyStats()
  }

  async function copySharedPreviewToLocal(sharedOutputPath: string, localOutputPath: string): Promise<boolean> {
    const timeoutMs = hydrateTimeoutMs()
    const tmpPath = `${localOutputPath}.hydrate.${process.pid}.${Date.now()}.tmp`
    const copyResult = await options.withIoDeadlineResult(`preview-cache-hydrate-copy:${sharedOutputPath}`, async () => {
      await fsp.mkdir(dirname(localOutputPath), { recursive: true })
      if (await pathExists(localOutputPath)) return true
      await fsp.copyFile(sharedOutputPath, tmpPath)
      if (await pathExists(localOutputPath)) {
        await fsp.unlink(tmpPath).catch(() => undefined)
        return true
      }
      await fsp.rename(tmpPath, localOutputPath).catch(async (error) => {
        await fsp.unlink(tmpPath).catch(() => undefined)
        throw error
      })
      return true
    }, timeoutMs)

    if (!copyResult.ok) {
      await fsp.unlink(tmpPath).catch(() => undefined)
      if (copyResult.timedOut) stats.deadlineDropped += 1
      return false
    }
    return true
  }

  async function hydrateOne(localStorage: PreviewCacheStorage, row: PreviewCacheHydrationRow): Promise<boolean> {
    const sharedStorage = options.previewCacheStorageToShared(localStorage)
    if (!sharedStorage?.rootPath) return false
    const key = sharedKey(sharedStorage, row.previewKey)
    if (hasSharedMiss(key)) {
      stats.sharedNegativeHit += 1
      return false
    }
    if (!(await options.ensureSharedAvailable(sharedStorage.rootPath))) {
      stats.sharedUnavailable += 1
      return false
    }

    const sharedOutputPath = join(sharedStorage.dir, `${row.previewKey}.png`)
    const cachedPresence = options.sharedPresence?.getSharedPresence(sharedStorage, row.previewKey) || null
    const persistentPresence = cachedPresence ? null : await options.sharedPresenceIndex?.getSharedPresenceIndex(sharedStorage, row.previewKey).catch(() => null) || null
    const effectivePresence = cachedPresence || persistentPresence
    if (effectivePresence === 'missing') {
      stats.sharedNegativeHit += 1
      if (persistentPresence === 'missing') stats.sharedPresenceIndexHit += 1
      rememberSharedMiss(key)
      return false
    }

    let indexedStatus: PreviewCacheIndexStatus | null = null
    if (effectivePresence === 'ok') {
      indexedStatus = 'ok'
      if (cachedPresence === 'ok') stats.sharedPresenceHit += 1
      if (persistentPresence === 'ok') stats.sharedPresenceIndexHit += 1
    } else {
      indexedStatus = await options.readPreviewCacheIndexStatus(sharedStorage, row.previewKey, sharedOutputPath).catch((error) => {
        stats.sharedUnavailable += 1
        options.appendStartupLog(`preview cache hydrate index failed: ${sharedOutputPath}, ${errorMessage(error)}`)
        return null
      })
    }

    if (indexedStatus !== 'ok') {
      rememberSharedMiss(key)
      options.sharedPresence?.rememberSharedPresence(sharedStorage, row.previewKey, 'missing')
      await options.sharedPresenceIndex?.rememberSharedPresenceIndex(sharedStorage, row.previewKey, 'missing')
      return false
    }

    const metaValidation = await options.validateSharedPreviewCacheMeta?.(sharedOutputPath, row).catch((error): PreviewCacheMetaValidationResult => ({ status: 'invalid', message: errorMessage(error) })) || { status: 'missing' as const }
    if (metaValidation.status === 'ok') stats.sharedMetaValidated += 1
    if (metaValidation.status === 'missing') stats.sharedMetaMissing += 1
    if (metaValidation.status === 'invalid' || metaValidation.status === 'mismatch') {
      stats.checksumMismatch += 1
      rememberSharedMiss(key)
      options.sharedPresence?.forgetSharedPresence(sharedStorage, row.previewKey)
      await options.sharedPresenceIndex?.forgetSharedPresenceIndex(sharedStorage, row.previewKey)
      options.appendStartupLog(`preview cache hydrate meta rejected: ${sharedOutputPath}, ${metaValidation.status}${metaValidation.message ? `, ${metaValidation.message}` : ''}`)
      return false
    }
    if (metaValidation.status === 'missing' && options.isStrictSharedMetaEnabled?.()) {
      stats.checksumMismatch += 1
      rememberSharedMiss(key)
      options.sharedPresence?.rememberSharedPresence(sharedStorage, row.previewKey, 'missing')
      await options.sharedPresenceIndex?.rememberSharedPresenceIndex(sharedStorage, row.previewKey, 'missing')
      return false
    }

    stats.sharedHit += 1
    options.sharedPresence?.rememberSharedPresence(sharedStorage, row.previewKey, 'ok')
    await options.sharedPresenceIndex?.rememberSharedPresenceIndex(sharedStorage, row.previewKey, 'ok')
    const hydrated = await copySharedPreviewToLocal(sharedOutputPath, row.outputPath)
    if (!hydrated) {
      options.sharedPresence?.forgetSharedPresence(sharedStorage, row.previewKey)
      await options.sharedPresenceIndex?.forgetSharedPresenceIndex(sharedStorage, row.previewKey)
      return false
    }

    await options.writePreviewCacheIndex(localStorage, row.previewKey, {
      outputPath: row.outputPath,
      fontSignature: row.fontSignature,
      textHash: row.textHash,
      fontSize: row.fontSize,
      width: row.width,
      height: row.height,
      status: 'ok',
      message: 'hydrated-from-shared-preview-cache',
      fontId: row.fontId,
      sourcePath: row.sourcePath,
    }).catch((error) => {
      options.appendStartupLog(`preview cache hydrate local index failed: ${row.outputPath}, ${errorMessage(error)}`)
    })

    stats.hydrated += 1
    return true
  }

  async function hydratePreviewCache(localStorage: PreviewCacheStorage, row: PreviewCacheHydrationRow): Promise<boolean> {
    const sharedStorage = options.previewCacheStorageToShared(localStorage)
    if (!sharedStorage) return false
    const key = sharedKey(sharedStorage, row.previewKey)
    const existing = inFlight.get(key)
    if (existing) return existing
    const task = hydrateOne(localStorage, row)
      .finally(() => {
        inFlight.delete(key)
        logStats()
      })
    inFlight.set(key, task)
    return task
  }

  async function hydratePreviewCacheRows(localStorage: PreviewCacheStorage, rows: PreviewCacheHydrationRow[]): Promise<Set<string>> {
    const hydratedIds = new Set<string>()
    const queue = rows.filter((row) => row?.id && row.previewKey && row.outputPath)
    if (!queue.length) return hydratedIds

    let index = 0
    const workerCount = Math.max(1, Math.min(hydrateMaxInFlight(), queue.length))
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (index < queue.length) {
        const row = queue[index]
        index += 1
        if (!row) continue
        if (await hydratePreviewCache(localStorage, row)) hydratedIds.add(row.id)
      }
    }))
    logStats()
    return hydratedIds
  }

  function rememberLocalHit(count = 1): void {
    stats.localHit += Math.max(0, count)
    logStats()
  }

  function rememberRenderQueued(count = 1): void {
    stats.renderQueued += Math.max(0, count)
    logStats()
  }

  return {
    hydratePreviewCache,
    hydratePreviewCacheRows,
    rememberLocalHit,
    rememberRenderQueued,
    logStats,
  }
}
