import { randomUUID } from 'node:crypto'
import { promises as localFs } from 'node:fs'
import { isCompletePreviewPng } from './previewImageValidationRuntime'
import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime'
import { applicationWorkEpoch, isApplicationClosing, onApplicationClosing } from '../../app/shutdownCoordinatorRuntime'
import { getStartupPathRootState } from '../../path/startupPathAvailabilityRuntime'
import { withPhysicalIoCompletion } from '../../path/ioDeadlineRuntime'
import { executeSharedFile, sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import type { PreviewCacheIndexStatus } from '../previewCacheRuntime'
import type { PreviewCacheStorage } from './previewRuntimeTypes'
import type { PreviewCacheMetaValidationResult } from './previewCacheMetaRuntime'
import type { PreviewCacheManifestEvent } from './previewCacheManifestRuntime'

export type PreviewCachePublishRow = {
  previewKey: string
  localOutputPath: string
  fontSignature: string
  textHash: string
  fontSize: number
  width: number
  height: number
  fontId?: string
  sourcePath?: string
  message?: string
}

export type PreviewCachePublishRuntimeOptions = {
  appendStartupLog: (message: string) => void
  withIoDeadlineResult: <T>(label: string, operation: () => Promise<T>, timeoutMs: number) => Promise<{ ok: true; value: T; timedOut?: boolean } | { ok: false; error: unknown; timedOut?: boolean }>
  writePreviewCacheIndex: (storage: PreviewCacheStorage, previewKey: string, data: { outputPath: string; fontSignature: string; textHash: string; fontSize: number; width: number; height: number; status: PreviewCacheIndexStatus; message?: string; fontId?: string; sourcePath?: string }) => Promise<void>
  previewCacheStorageToShared: (storage: PreviewCacheStorage) => PreviewCacheStorage | null
  ensureSharedAvailable: (rootPath: string) => Promise<boolean>
  writeSharedPreviewCacheMeta?: (outputPath: string, row: PreviewCachePublishRow, bytes?: Buffer) => Promise<void>
  validateSharedPreviewCacheMeta?: (outputPath: string, row: PreviewCachePublishRow, bytes?: Buffer) => Promise<PreviewCacheMetaValidationResult>
  appendSharedPreviewCacheManifest?: (storage: PreviewCacheStorage, row: PreviewCachePublishRow, outputPath: string, event: PreviewCacheManifestEvent, metaValidation?: PreviewCacheMetaValidationResult | null) => Promise<void>
}

const DEFAULT_PUBLISH_DELAY_MS = 7000
const DEFAULT_PUBLISH_TIMEOUT_MS = 2000
const DEFAULT_PUBLISH_MAX_IN_FLIGHT = 1
const DEFAULT_PUBLISH_LOCK_TTL_MS = 30000
const DEFAULT_STATS_LOG_INTERVAL_MS = 10000

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function publishDelayMs(): number {
  return parseEnvInt('HFM_PREVIEW_PUBLISH_DELAY_MS', DEFAULT_PUBLISH_DELAY_MS, 0, 60000)
}

function publishTimeoutMs(): number {
  return parseEnvInt('HFM_PREVIEW_PUBLISH_TIMEOUT_MS', DEFAULT_PUBLISH_TIMEOUT_MS, 200, 60000)
}

function publishMaxInFlight(): number {
  return parseEnvInt('HFM_PREVIEW_PUBLISH_MAX_IN_FLIGHT', DEFAULT_PUBLISH_MAX_IN_FLIGHT, 1, 4)
}

function lockTtlMs(): number {
  return parseEnvInt('HFM_PREVIEW_PUBLISH_LOCK_TTL_MS', DEFAULT_PUBLISH_LOCK_TTL_MS, 5000, 5 * 60 * 1000)
}

function machineId(): string {
  return `${hostname() || 'unknown'}:${process.pid}`
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

async function acquirePublishLock(lockPath: string) {
  const isolated = (await sharedIoResourceKeys([lockPath])).length > 0
  const open = () => fsp.open(lockPath, 'wx')
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !isolated) return null
    // Native removal compares the exact object, never a read-then-blind-unlink.
    await executeSharedFile({operation: 'removeStaleLock', path: lockPath, olderThanMs: Date.now() - lockTtlMs()}).catch(() => undefined)
    try { handle = await open() } catch { return null }
  }
  type Owned = { removeOwned: () => Promise<void>; renameOwned: (source: string, dest: string) => Promise<void> }
  const owned = handle as unknown as Owned
  const identity = isolated ? undefined : await handle.stat()
  const localCurrent = async () => {
    const current = await fsp.lstat(lockPath)
    return current.dev === identity?.dev && current.ino === identity?.ino
  }
  try { await handle.writeFile(JSON.stringify({ machineId: machineId(), operation: 'preview-cache-publish', createdAt: Date.now(), token: randomUUID() }), 'utf-8') }
  catch { await handle.close().catch(() => undefined); return null }
  return {
    rename: async (source: string, dest: string) => {
      if (isolated) await owned.renameOwned(source, dest)
      else {
        if (!(await localCurrent())) throw new Error('preview publish lock replaced')
        await fsp.rename(source, dest)
      }
    },
    release: async () => {
      try {
        if (isolated) await owned.removeOwned()
        else if (await localCurrent()) await fsp.unlink(lockPath)
      } catch { /* A later owner is authoritative; never remove it by pathname. */ }
      finally { await handle.close().catch(() => undefined) }
    },
  }
}

export function createPreviewCachePublishRuntime(options: PreviewCachePublishRuntimeOptions) {
  const queue = new Map<string, { storage: PreviewCacheStorage; row: PreviewCachePublishRow }>()
  const inFlight = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let active = 0
  let lastStatsLogAt = 0
  const stats = {
    queued: 0,
    coalesced: 0,
    published: 0,
    skippedExisting: 0,
    sharedUnavailable: 0,
    deadlineDropped: 0,
    lockBusy: 0,
    metaWritten: 0,
    checksumMismatch: 0,
    manifestWritten: 0,
    indexSkipped: 0,
  }

  function logStats(force = false): void {
    const now = Date.now()
    if (!force && now - lastStatsLogAt < DEFAULT_STATS_LOG_INTERVAL_MS) return
    const total = stats.queued + stats.coalesced + stats.published + stats.skippedExisting + stats.sharedUnavailable + stats.deadlineDropped + stats.lockBusy + stats.metaWritten + stats.checksumMismatch + stats.manifestWritten + stats.indexSkipped
    if (!total) return
    lastStatsLogAt = now
    options.appendStartupLog(`preview cache publish summary: queued=${stats.queued}, coalesced=${stats.coalesced}, published=${stats.published}, skippedExisting=${stats.skippedExisting}, sharedUnavailable=${stats.sharedUnavailable}, deadlineDropped=${stats.deadlineDropped}, lockBusy=${stats.lockBusy}, metaWritten=${stats.metaWritten}, checksumMismatch=${stats.checksumMismatch}, manifestWritten=${stats.manifestWritten}, indexSkipped=${stats.indexSkipped}`)
    stats.queued = 0
    stats.coalesced = 0
    stats.published = 0
    stats.skippedExisting = 0
    stats.sharedUnavailable = 0
    stats.deadlineDropped = 0
    stats.lockBusy = 0
    stats.metaWritten = 0
    stats.checksumMismatch = 0
    stats.manifestWritten = 0
    stats.indexSkipped = 0
  }

  function schedulePump(): void {
    if (timer || isApplicationClosing()) return
    timer = setTimeout(() => {
      timer = null
      pump()
    }, publishDelayMs())
  }

  function publishKey(storage: PreviewCacheStorage, previewKey: string): string {
    return `${storage.rootPath || storage.indexDbPath || storage.dir}:${storage.rootPath ? getStartupPathRootState(storage.rootPath).generation : 0}:${previewKey}`
  }

  async function publishOne(storage: PreviewCacheStorage, row: PreviewCachePublishRow): Promise<void> {
    if (!storage.rootPath || isApplicationClosing()) return
    const epoch = applicationWorkEpoch(), generation = getStartupPathRootState(storage.rootPath).generation
    const current = () => !isApplicationClosing() && applicationWorkEpoch() === epoch && getStartupPathRootState(storage.rootPath!).generation === generation && getStartupPathRootState(storage.rootPath!).state !== 'offline'
    if (!(await options.ensureSharedAvailable(storage.rootPath))) {
      stats.sharedUnavailable += 1
      return
    }

    const sharedOutputPath = join(storage.dir, `${row.previewKey}.png`)
    const lockPath = `${sharedOutputPath}.publish.lock`
    const tmpPath = `${sharedOutputPath}.tmp.${randomUUID()}`
    const mkdirResult = await withPhysicalIoCompletion(() => options.withIoDeadlineResult(`preview-cache-publish-mkdir:${dirname(sharedOutputPath)}`, () => fsp.mkdir(dirname(sharedOutputPath), { recursive: true }), publishTimeoutMs()))
    if (!mkdirResult.ok) {
      if (mkdirResult.timedOut) stats.deadlineDropped += 1
      options.appendStartupLog(`preview cache publish mkdir dropped: ${dirname(sharedOutputPath)}, ${errorMessage(mkdirResult.error)}`)
      return
    }
    if (!current()) return
    const lock = await acquirePublishLock(lockPath)
    if (!lock) {
      stats.lockBusy += 1
      return
    }

    try {
      let expired = false
      let publishedBytes: Buffer | undefined
      const result = await withPhysicalIoCompletion(() => options.withIoDeadlineResult(`preview-cache-publish:${sharedOutputPath}`, async () => {
        if (!current()) throw new Error('preview publish cancelled')
        if (await pathExists(sharedOutputPath)) return 'exists' as const
        // Publish a stable local byte snapshot. The image and its checksum use
        // these exact bytes, avoiding two additional reads of the shared PNG.
        const bytes = await localFs.readFile(row.localOutputPath)
        if (!isCompletePreviewPng(bytes)) throw new Error('preview publish invalid local PNG')
        await fsp.writeFile(tmpPath, bytes)
        publishedBytes = bytes
        if (await pathExists(sharedOutputPath)) return 'exists-after-copy' as const
        if (expired || !current()) throw new Error('preview publish expired')
        await lock.rename(tmpPath, sharedOutputPath)
        return 'published' as const
      }, publishTimeoutMs()).then(result => { expired = !result.ok; return result }))

      await fsp.unlink(tmpPath).catch(() => undefined)
      if (!current()) return
      if (!result.ok) {
        if (result.timedOut) stats.deadlineDropped += 1
        options.appendStartupLog(`preview cache publish dropped: ${sharedOutputPath}, ${errorMessage(result.error)}`)
        return
      }

      let manifestEvent: PreviewCacheManifestEvent = 'existing'
      let metaValidation: PreviewCacheMetaValidationResult | null = null
      let shouldWriteSharedIndex = true

      if (result.value === 'published') {
        stats.published += 1
        manifestEvent = 'published'
        await options.writeSharedPreviewCacheMeta?.(sharedOutputPath, row, publishedBytes)
          .then(() => {
            stats.metaWritten += 1
          })
          .catch((error) => {
            stats.checksumMismatch += 1
            options.appendStartupLog(`preview cache publish meta failed: ${sharedOutputPath}, ${errorMessage(error)}`)
          })
        metaValidation = await options.validateSharedPreviewCacheMeta?.(sharedOutputPath, row, publishedBytes).catch((error): PreviewCacheMetaValidationResult => ({ status: 'invalid', message: errorMessage(error) })) || null
        if (metaValidation && metaValidation.status !== 'ok') {
          shouldWriteSharedIndex = false
          manifestEvent = 'meta-mismatch'
          stats.checksumMismatch += 1
          stats.indexSkipped += 1
        }
      } else {
        stats.skippedExisting += 1
        metaValidation = await options.validateSharedPreviewCacheMeta?.(sharedOutputPath, row).catch((error): PreviewCacheMetaValidationResult => ({ status: 'invalid', message: errorMessage(error) })) || null
        if (metaValidation && (metaValidation.status === 'invalid' || metaValidation.status === 'mismatch')) {
          manifestEvent = 'meta-mismatch'
          shouldWriteSharedIndex = false
          stats.checksumMismatch += 1
          stats.indexSkipped += 1
          options.appendStartupLog(`preview cache publish existing meta mismatch: ${sharedOutputPath}, ${metaValidation.status}${metaValidation.message ? `, ${metaValidation.message}` : ''}`)
        }
      }

      if (!current()) return
      await options.appendSharedPreviewCacheManifest?.(storage, row, sharedOutputPath, manifestEvent, metaValidation)
        .then(() => {
          stats.manifestWritten += 1
        })
        .catch((error) => {
          options.appendStartupLog(`preview cache publish manifest failed: ${sharedOutputPath}, ${errorMessage(error)}`)
        })

      if (shouldWriteSharedIndex && current()) {
        await options.writePreviewCacheIndex(storage, row.previewKey, {
          outputPath: sharedOutputPath,
          fontSignature: row.fontSignature,
          textHash: row.textHash,
          fontSize: row.fontSize,
          width: row.width,
          height: row.height,
          status: 'ok',
          message: row.message || 'published-from-local-preview-cache',
          fontId: row.fontId,
          sourcePath: row.sourcePath,
        }).catch((error) => {
          options.appendStartupLog(`preview cache publish index failed: ${sharedOutputPath}, ${errorMessage(error)}`)
        })
      }
    } finally {
      await lock.release()
      await fsp.unlink(tmpPath).catch(() => undefined)
      logStats()
    }
  }

  function pump(): void {
    while (!isApplicationClosing() && active < publishMaxInFlight() && queue.size) {
      const first = queue.entries().next().value as [string, { storage: PreviewCacheStorage; row: PreviewCachePublishRow }] | undefined
      if (!first) break
      const [key, task] = first
      queue.delete(key)
      inFlight.add(key)
      active += 1
      withPhysicalIoCompletion(() => publishOne(task.storage, task.row))
        .catch((error) => options.appendStartupLog(`preview cache publish failed: ${errorMessage(error)}`))
        .finally(() => {
          inFlight.delete(key)
          active = Math.max(0, active - 1)
          if (queue.size) schedulePump()
        })
    }
  }

  function enqueuePreviewCachePublish(localStorage: PreviewCacheStorage, row: PreviewCachePublishRow): void {
    if (isApplicationClosing()) return
    const sharedStorage = options.previewCacheStorageToShared(localStorage)
    if (!sharedStorage?.rootPath) return
    const key = publishKey(sharedStorage, row.previewKey)
    if (queue.has(key) || inFlight.has(key)) {
      stats.coalesced += 1
      logStats()
      return
    }
    queue.set(key, { storage: sharedStorage, row })
    while (queue.size > 2000) queue.delete(queue.keys().next().value!)
    stats.queued += 1
    schedulePump()
    logStats()
  }

  onApplicationClosing(() => { if (timer) clearTimeout(timer); timer = null; queue.clear() })
  return {
    enqueuePreviewCachePublish,
    logStats,
  }
}
