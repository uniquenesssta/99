import { promises as fsp } from 'node:fs'
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
  writeSharedPreviewCacheMeta?: (outputPath: string, row: PreviewCachePublishRow) => Promise<void>
  validateSharedPreviewCacheMeta?: (outputPath: string, row: PreviewCachePublishRow) => Promise<PreviewCacheMetaValidationResult>
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

async function acquirePublishLock(lockPath: string): Promise<(() => Promise<void>) | null> {
  const now = Date.now()
  const payload = JSON.stringify({ machineId: machineId(), operation: 'preview-cache-publish', createdAt: now, expiresAt: now + lockTtlMs() })
  try {
    const handle = await fsp.open(lockPath, 'wx')
    await handle.writeFile(payload, 'utf-8')
    await handle.close()
    return async () => {
      await fsp.unlink(lockPath).catch(() => undefined)
    }
  } catch {
    try {
      const raw = await fsp.readFile(lockPath, 'utf-8')
      const parsed = JSON.parse(raw) as { expiresAt?: number }
      if (Number(parsed.expiresAt || 0) > now) return null
      await fsp.unlink(lockPath).catch(() => undefined)
      const handle = await fsp.open(lockPath, 'wx')
      await handle.writeFile(payload, 'utf-8')
      await handle.close()
      return async () => {
        await fsp.unlink(lockPath).catch(() => undefined)
      }
    } catch {
      return null
    }
  }
}

export function createPreviewCachePublishRuntime(options: PreviewCachePublishRuntimeOptions) {
  const queue = new Map<string, { storage: PreviewCacheStorage; row: PreviewCachePublishRow }>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let active = 0
  let lastStatsLogAt = 0
  const stats = {
    queued: 0,
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
    const total = stats.queued + stats.published + stats.skippedExisting + stats.sharedUnavailable + stats.deadlineDropped + stats.lockBusy + stats.metaWritten + stats.checksumMismatch + stats.manifestWritten + stats.indexSkipped
    if (!total) return
    lastStatsLogAt = now
    options.appendStartupLog(`preview cache publish summary: queued=${stats.queued}, published=${stats.published}, skippedExisting=${stats.skippedExisting}, sharedUnavailable=${stats.sharedUnavailable}, deadlineDropped=${stats.deadlineDropped}, lockBusy=${stats.lockBusy}, metaWritten=${stats.metaWritten}, checksumMismatch=${stats.checksumMismatch}, manifestWritten=${stats.manifestWritten}, indexSkipped=${stats.indexSkipped}`)
    stats.queued = 0
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
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      pump()
    }, publishDelayMs())
  }

  function publishKey(storage: PreviewCacheStorage, previewKey: string): string {
    return `${storage.rootPath || storage.indexDbPath || storage.dir}:${previewKey}`
  }

  async function publishOne(storage: PreviewCacheStorage, row: PreviewCachePublishRow): Promise<void> {
    if (!storage.rootPath) return
    if (!(await options.ensureSharedAvailable(storage.rootPath))) {
      stats.sharedUnavailable += 1
      return
    }

    const sharedOutputPath = join(storage.dir, `${row.previewKey}.png`)
    const lockPath = `${sharedOutputPath}.publish.lock`
    const tmpPath = `${sharedOutputPath}.tmp.${process.pid}.${Date.now()}`
    const mkdirResult = await options.withIoDeadlineResult(`preview-cache-publish-mkdir:${dirname(sharedOutputPath)}`, () => fsp.mkdir(dirname(sharedOutputPath), { recursive: true }), publishTimeoutMs())
    if (!mkdirResult.ok) {
      if (mkdirResult.timedOut) stats.deadlineDropped += 1
      options.appendStartupLog(`preview cache publish mkdir dropped: ${dirname(sharedOutputPath)}, ${errorMessage(mkdirResult.error)}`)
      return
    }
    const release = await acquirePublishLock(lockPath)
    if (!release) {
      stats.lockBusy += 1
      return
    }

    try {
      const result = await options.withIoDeadlineResult(`preview-cache-publish:${sharedOutputPath}`, async () => {
        if (await pathExists(sharedOutputPath)) return 'exists' as const
        await fsp.copyFile(row.localOutputPath, tmpPath)
        if (await pathExists(sharedOutputPath)) return 'exists-after-copy' as const
        await fsp.rename(tmpPath, sharedOutputPath)
        return 'published' as const
      }, publishTimeoutMs())

      await fsp.unlink(tmpPath).catch(() => undefined)
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
        await options.writeSharedPreviewCacheMeta?.(sharedOutputPath, row)
          .then(() => {
            stats.metaWritten += 1
          })
          .catch((error) => {
            stats.checksumMismatch += 1
            options.appendStartupLog(`preview cache publish meta failed: ${sharedOutputPath}, ${errorMessage(error)}`)
          })
        metaValidation = await options.validateSharedPreviewCacheMeta?.(sharedOutputPath, row).catch((error): PreviewCacheMetaValidationResult => ({ status: 'invalid', message: errorMessage(error) })) || null
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

      await options.appendSharedPreviewCacheManifest?.(storage, row, sharedOutputPath, manifestEvent, metaValidation)
        .then(() => {
          stats.manifestWritten += 1
        })
        .catch((error) => {
          options.appendStartupLog(`preview cache publish manifest failed: ${sharedOutputPath}, ${errorMessage(error)}`)
        })

      if (shouldWriteSharedIndex) {
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
      await release()
      await fsp.unlink(tmpPath).catch(() => undefined)
      logStats()
    }
  }

  function pump(): void {
    while (active < publishMaxInFlight() && queue.size) {
      const first = queue.entries().next().value as [string, { storage: PreviewCacheStorage; row: PreviewCachePublishRow }] | undefined
      if (!first) break
      const [key, task] = first
      queue.delete(key)
      active += 1
      publishOne(task.storage, task.row)
        .catch((error) => options.appendStartupLog(`preview cache publish failed: ${errorMessage(error)}`))
        .finally(() => {
          active = Math.max(0, active - 1)
          if (queue.size) schedulePump()
        })
    }
  }

  function enqueuePreviewCachePublish(localStorage: PreviewCacheStorage, row: PreviewCachePublishRow): void {
    const sharedStorage = options.previewCacheStorageToShared(localStorage)
    if (!sharedStorage?.rootPath) return
    queue.set(publishKey(sharedStorage, row.previewKey), { storage: sharedStorage, row })
    stats.queued += 1
    schedulePump()
    logStats()
  }

  return {
    enqueuePreviewCachePublish,
    logStats,
  }
}
