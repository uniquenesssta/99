import { previewCacheErrorOutcome, type PreviewCacheHydrationOutcome } from './previewCacheOutcomeRuntime'
import { claimPreviewImage } from './previewImageCommitRuntime'
import { isCompletePreviewPng } from './previewImageValidationRuntime'
import { getStartupPathRootState } from '../../path/startupPathAvailabilityRuntime'
import { withPhysicalIoCompletion } from '../../path/ioDeadlineRuntime'
import { withSharedIoSignal, sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
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
  legacyRootPreviewCacheDir?: (rootPath: string) => string
  touchSharedPreviewCache?: (storage: PreviewCacheStorage, keys: string[]) => Promise<void>
  sharedPresence?: PreviewCacheSharedPresenceRuntime
  sharedPresenceIndex?: PreviewCacheSharedPresenceIndexRuntime
  validateSharedPreviewCacheMeta?: (outputPath: string, row: PreviewCacheHydrationRow, bytes?: Buffer) => Promise<PreviewCacheMetaValidationResult>
  isStrictSharedMetaEnabled?: () => boolean
}

const DEFAULT_HYDRATE_MAX_IN_FLIGHT = 2
const DEFAULT_HYDRATE_TIMEOUT_MS = 2000
const DEFAULT_SHARED_NEGATIVE_TTL_MS = 1000
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
  return parseEnvInt('HFM_PREVIEW_SHARED_NEGATIVE_TTL_MS', DEFAULT_SHARED_NEGATIVE_TTL_MS, 100, 1000)
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

export function createPreviewCacheHydrationRuntime(options: PreviewCacheHydrationRuntimeOptions) {
  const inFlight = new Map<string, Promise<PreviewCacheHydrationOutcome>>()
  const negative = new Map<string, number>()
  let stats = emptyStats()
  let lastStatsLogAt = 0

  function sharedKey(storage: PreviewCacheStorage, previewKey: string): string {
    return `${storage.rootPath || storage.indexDbPath || storage.dir}:${storage.rootPath ? getStartupPathRootState(storage.rootPath).generation : 0}:${previewKey}`
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

  async function hydrateOne(localStorage: PreviewCacheStorage, row: PreviewCacheHydrationRow): Promise<PreviewCacheHydrationOutcome> {
    const sharedStorage = options.previewCacheStorageToShared(localStorage)
    if (!sharedStorage?.rootPath) return 'unavailable'
    const key = sharedKey(sharedStorage, row.previewKey)
    if (!(await options.ensureSharedAvailable(sharedStorage.rootPath))) {
      stats.sharedUnavailable += 1
      return 'unavailable'
    }
    const generation = getStartupPathRootState(sharedStorage.rootPath).generation
    const lease = claimPreviewImage(row.outputPath, 'hydrate', () => {
      const state = getStartupPathRootState(sharedStorage.rootPath!)
      return state.generation === generation && state.state !== 'offline'
    })
    try {
    return await withSharedIoSignal(lease.signal, async () => {
        if (!lease.current()) return 'cancelled'
        let sharedOutputPath = join(sharedStorage.dir, `${row.previewKey}.png`)
        const cachedPresence = options.sharedPresence?.getSharedPresence(sharedStorage, row.previewKey) || null
        const persistentPresence = cachedPresence ? null : await options.sharedPresenceIndex?.getSharedPresenceIndex(sharedStorage, row.previewKey).catch(() => null) || null
        const effectivePresence = cachedPresence || persistentPresence
        // Historical missing rows have no trustworthy provenance. Recheck them;
        // only this generation's successful query may briefly suppress a repeat.
        if (effectivePresence !== 'ok' && hasSharedMiss(key)) { stats.sharedNegativeHit += 1; return 'miss' }
        let indexedStatus: PreviewCacheIndexStatus | null = null
        if (effectivePresence === 'ok') {
          indexedStatus = 'ok'
          if (cachedPresence === 'ok') stats.sharedPresenceHit += 1
          if (persistentPresence === 'ok') stats.sharedPresenceIndexHit += 1
        } else {
          try {
            indexedStatus = await options.readPreviewCacheIndexStatus(sharedStorage, row.previewKey, sharedOutputPath)
          } catch (error) {
            const outcome = previewCacheErrorOutcome(error)
            if (outcome === 'cancelled') return outcome
            if (outcome === 'timeout') stats.deadlineDropped += 1
            else if (outcome !== 'miss') stats.sharedUnavailable += 1
            options.appendStartupLog(`preview cache hydrate index ${outcome}: ${sharedOutputPath}, ${errorMessage(error)}`)
            // Legacy image-only caches need no DB. This stays background work;
            // an index outage is never persisted as an absent image.
            if (!options.legacyRootPreviewCacheDir) return outcome
          }
        }
        if (!lease.current()) return 'cancelled'

        if (indexedStatus !== 'ok') {
          if (!options.legacyRootPreviewCacheDir) { rememberSharedMiss(key); return 'miss' }
          sharedOutputPath = join(options.legacyRootPreviewCacheDir(sharedStorage.rootPath!), `${row.previewKey}.png`)
        }

        // One network PNG read; validation and the local copy consume exactly these bytes.
        const read = await withPhysicalIoCompletion(() => options.withIoDeadlineResult(`preview-cache-hydrate-read:${sharedOutputPath}`, () => fsp.readFile(sharedOutputPath), hydrateTimeoutMs()))
        if (!lease.current()) return 'cancelled'
        if (!read.ok) {
          const outcome = read.timedOut ? 'timeout' : previewCacheErrorOutcome(read.error)
          if (outcome === 'cancelled') return outcome
          if (outcome === 'timeout') stats.deadlineDropped += 1
          else if (outcome !== 'miss') stats.sharedUnavailable += 1
          options.appendStartupLog(`preview cache hydrate read ${outcome}: ${sharedOutputPath}, ${errorMessage(read.error)}`)
          options.sharedPresence?.forgetSharedPresence(sharedStorage, row.previewKey)
          await options.sharedPresenceIndex?.forgetSharedPresenceIndex(sharedStorage, row.previewKey)
          return outcome
        }
        const bytes = read.value
        if (!isCompletePreviewPng(bytes)) {
          options.appendStartupLog(`preview cache hydrate invalid PNG: ${sharedOutputPath}`)
          return 'error'
        }
        const metaValidation = await options.validateSharedPreviewCacheMeta?.(sharedOutputPath, row, bytes).catch((error): PreviewCacheMetaValidationResult => ({ status: 'invalid', message: errorMessage(error) })) || { status: 'missing' as const }
        if (metaValidation.status === 'ok') stats.sharedMetaValidated += 1
        if (metaValidation.status === 'missing') stats.sharedMetaMissing += 1
        if (metaValidation.status === 'invalid' || metaValidation.status === 'mismatch') {
          stats.checksumMismatch += 1
          rememberSharedMiss(key)
          options.sharedPresence?.forgetSharedPresence(sharedStorage, row.previewKey)
          await options.sharedPresenceIndex?.forgetSharedPresenceIndex(sharedStorage, row.previewKey)
          options.appendStartupLog(`preview cache hydrate meta rejected: ${sharedOutputPath}, ${metaValidation.status}${metaValidation.message ? `, ${metaValidation.message}` : ''}`)
          return 'error'
        }
        if (metaValidation.status === 'missing' && options.isStrictSharedMetaEnabled?.()) {
          stats.checksumMismatch += 1
          rememberSharedMiss(key)
          return 'error'
        }

        stats.sharedHit += 1
        if (indexedStatus === 'ok') {
          options.sharedPresence?.rememberSharedPresence(sharedStorage, row.previewKey, 'ok')
          await options.sharedPresenceIndex?.rememberSharedPresenceIndex(sharedStorage, row.previewKey, 'ok')
        }
        if (!lease.current()) return 'cancelled'
        await fsp.mkdir(dirname(row.outputPath), { recursive: true })
        await fsp.writeFile(lease.temporaryPath, bytes)
        if (!(await lease.commit())) return 'cancelled'
        negative.delete(key)

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
        return 'hydrated'
    })
    } finally { await lease.release() }
  }

  async function hydratePreviewCacheOutcome(localStorage: PreviewCacheStorage, row: PreviewCacheHydrationRow): Promise<PreviewCacheHydrationOutcome> {
    const sharedStorage = options.previewCacheStorageToShared(localStorage)
    if (!sharedStorage) return 'unavailable'
    const key = `${sharedKey(sharedStorage, row.previewKey)}:${row.outputPath}`
    const existing = inFlight.get(key)
    if (existing) return existing
    const task = withPhysicalIoCompletion(() => hydrateOne(localStorage, row))
      .finally(() => {
        inFlight.delete(key)
        logStats()
      })
    inFlight.set(key, task)
    return task
  }

  async function hydratePreviewCache(localStorage: PreviewCacheStorage, row: PreviewCacheHydrationRow): Promise<boolean> {
    return (await hydratePreviewCacheOutcome(localStorage, row)) === 'hydrated'
  }

  async function hydratePreviewCacheRows(localStorage: PreviewCacheStorage, rows: PreviewCacheHydrationRow[], current = () => true, report?: (row: PreviewCacheHydrationRow, outcome: PreviewCacheHydrationOutcome) => void): Promise<Set<string>> {
    const hydratedIds = new Set<string>()
    const sharedStorage = options.previewCacheStorageToShared(localStorage)
    const generation = sharedStorage?.rootPath ? getStartupPathRootState(sharedStorage.rootPath).generation : undefined
    const queue = rows.filter((row) => row?.id && row.previewKey && row.outputPath)
    if (!queue.length) return hydratedIds

    let index = 0
    const workerCount = Math.max(1, Math.min(hydrateMaxInFlight(), queue.length))
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (current() && index < queue.length) {
        const row = queue[index]
        index += 1
        if (!row) continue
        let outcome: PreviewCacheHydrationOutcome
        try { outcome = await hydratePreviewCacheOutcome(localStorage, row) }
        catch (error) {
          outcome = previewCacheErrorOutcome(error)
          options.appendStartupLog(`preview cache hydrate ${outcome}: ${row.previewKey}, ${errorMessage(error)}`)
        }
        if (!current()) outcome = 'cancelled'
        if (outcome === 'hydrated') hydratedIds.add(row.id)
        report?.(row, outcome)
      }
    }))
    for (; index < queue.length; index++) report?.(queue[index]!, 'cancelled')
    // The existing bounded prefetch batch owns one deduplicated maintenance write.
    // Single-item lookups never spawn a touch task of their own.
    if (current() && sharedStorage && hydratedIds.size && (!sharedStorage.rootPath || getStartupPathRootState(sharedStorage.rootPath).generation === generation)) {
      const keys = [...new Set(queue.filter(row => hydratedIds.has(row.id)).map(row => row.previewKey))]
      await options.touchSharedPreviewCache?.(sharedStorage, keys).catch(error => {
        options.appendStartupLog(`preview cache batch touch unavailable: ${errorMessage(error)}`)
      })
    }
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
