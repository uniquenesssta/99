import { cacheMaintenancePending, registerCacheMaintenanceParticipant } from '../../maintenance/cacheMaintenanceCoordinator'
import { PreviewSharedPreparationDeferred, createPreviewPreparationEvidenceLogger, previewPreparationRetryable } from './previewSharedPreparationRuntime'
import { randomUUID } from 'node:crypto'
import { promises as localFs } from 'node:fs'
import { isCompletePreviewPng } from './previewImageValidationRuntime'
import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime'
import { applicationWorkEpoch, isApplicationClosing, onApplicationClosing } from '../../app/shutdownCoordinatorRuntime'
import { getStartupPathRootState, withStartupPathRootGuard } from '../../path/startupPathAvailabilityRuntime'
import { awaitPhysicalIoClose, withPhysicalIoCompletion } from '../../path/ioDeadlineRuntime'
import { executeSharedFile, sharedFileSystem as fsp, withSharedIoPriority, withSharedIoQueueTimeout, withSharedIoSignal, withoutSharedIoSignal } from '../../path/sharedFileSystemRuntime'
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
  ensureSharedAvailable: (rootPath: string, force?: boolean) => Promise<boolean>
  writeSharedPreviewCacheMeta?: (outputPath: string, row: PreviewCachePublishRow, bytes?: Buffer) => Promise<void>
  validateSharedPreviewCacheMeta?: (outputPath: string, row: PreviewCachePublishRow, bytes?: Buffer) => Promise<PreviewCacheMetaValidationResult>
  appendSharedPreviewCacheManifest?: (storage: PreviewCacheStorage, row: PreviewCachePublishRow, outputPath: string, event: PreviewCacheManifestEvent, metaValidation?: PreviewCacheMetaValidationResult | null) => Promise<void>
}

const DEFAULT_PUBLISH_DELAY_MS = 7000
const DEFAULT_PUBLISH_TIMEOUT_MS = 6000
const DEFAULT_PUBLISH_MAX_IN_FLIGHT = 1
const DEFAULT_PUBLISH_LOCK_TTL_MS = 30000
const DEFAULT_STATS_LOG_INTERVAL_MS = 10000
const MAX_PENDING_MS = 5 * 60 * 1000
const MAX_PENDING_ROWS = 2000
type PublishTask = {
  storage: PreviewCacheStorage
  row: PreviewCachePublishRow
  rootId: string
  generation: number
  epoch: number
  expiresAt: number
  notBefore: number
  forcePreparation: boolean
  controller: AbortController
}

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
  } catch (error) {
    const code = (error as { code?: string; reason?: string })?.code || (error as { reason?: string })?.reason
    if (code === 'ENOENT' || code === 'ENOTDIR') return false
    throw error
  }
}

async function acquirePublishLock(lockPath: string) {
  const isolated = (await sharedIoResourceKeys([lockPath])).length > 0
  const open = () => fsp.open(lockPath, 'wx')
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open() }
  catch (error) {
    await awaitPhysicalIoClose(error)
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!isolated) return null
    // Native removal compares the exact object, never a read-then-blind-unlink.
    await executeSharedFile({operation: 'removeStaleLock', path: lockPath, olderThanMs: Date.now() - lockTtlMs()}).catch(async error => { await awaitPhysicalIoClose(error) })
    try { handle = await open() } catch (error) { await awaitPhysicalIoClose(error); if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null; throw error }
  }
  type Owned = { removeOwned: () => Promise<void>; renameOwned: (source: string, dest: string) => Promise<void> }
  const owned = handle as unknown as Owned
  const identity = isolated ? undefined : await handle.stat()
  const localCurrent = async () => {
    const current = await fsp.lstat(lockPath)
    return current.dev === identity?.dev && current.ino === identity?.ino
  }
  try { await handle.writeFile(JSON.stringify({ machineId: machineId(), operation: 'preview-cache-publish', createdAt: Date.now(), token: randomUUID() }), 'utf-8') }
  catch (error) { await awaitPhysicalIoClose(error); await handle.close().catch(async error => { await awaitPhysicalIoClose(error) }); return null }
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
      } catch (error) { await awaitPhysicalIoClose(error) /* A later owner is authoritative; never remove it by pathname. */ }
      finally { await handle.close().catch(async error => { await awaitPhysicalIoClose(error) }) }
    },
  }
}

export function createPreviewCachePublishRuntime(options: PreviewCachePublishRuntimeOptions) {
  const queue = new Map<string, PublishTask>()
  const inFlight = new Map<string, PublishTask>()
  const rootRetryAt = new Map<string, number>()
  const evidence = createPreviewPreparationEvidenceLogger(options.appendStartupLog)
  const idleWaiters: Array<() => void> = []
  const resolveIdle = () => { if (!active && !queue.size) for (const done of idleWaiters.splice(0)) done() }
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

  function rootKey(task: PublishTask): string { return `${task.rootId}:${task.generation}` }
  function current(task: PublishTask): boolean {
    const state = getStartupPathRootState(task.storage.rootPath!)
    return !isApplicationClosing() && !task.controller.signal.aborted && applicationWorkEpoch() === task.epoch
      && state.rootId === task.rootId && state.generation === task.generation && state.state !== 'offline'
  }
  function schedulePump(): void {
    if (timer || isApplicationClosing() || !queue.size) return
    const runningRoots = new Set([...inFlight.values()].map(rootKey))
    const pending = [...queue.values()].filter(task => !runningRoots.has(rootKey(task)))
    if (!pending.length) return
    const next = Math.min(...pending.map(task => Math.max(task.notBefore, rootRetryAt.get(rootKey(task)) || 0)))
    timer = setTimeout(() => { timer = null; pump() }, Math.max(0, next - Date.now()))
  }

  async function publishOne(task: PublishTask): Promise<void> {
    const { storage, row } = task
    const guarded = <T>(operation: () => Promise<T>) => withStartupPathRootGuard(() => {
      if (!current(task)) throw Object.assign(new Error('Preview publication owner retired'), { reason: 'stale-generation' })
    }, operation)
    if (!current(task)) return
    if (!(await options.ensureSharedAvailable(storage.rootPath!, task.forcePreparation))) {
      stats.sharedUnavailable += 1
      return
    }
    task.forcePreparation = false
    if (!current(task)) return

    const sharedOutputPath = join(storage.dir, `${row.previewKey}.png`)
    const lockPath = `${sharedOutputPath}.publish.lock`
    const tmpPath = `${sharedOutputPath}.tmp.${randomUUID()}`
    const mkdirResult = await withPhysicalIoCompletion(() => options.withIoDeadlineResult(`preview-cache-publish-mkdir:${dirname(sharedOutputPath)}`, () => guarded(() => fsp.mkdir(dirname(sharedOutputPath), { recursive: true })), publishTimeoutMs()))
    if (!mkdirResult.ok) {
      if (mkdirResult.timedOut) stats.deadlineDropped += 1
      const code = (mkdirResult.error as { code?: string; reason?: string })?.code || (mkdirResult.error as { reason?: string })?.reason
      if (previewPreparationRetryable(mkdirResult.error)) {
        task.forcePreparation = code === 'ENOENT' || code === 'ENOTDIR'
        const cause = mkdirResult.error as { phase?: 'queued' | 'executing'; blocker?: string; requestId?: number; blockedBy?: number }
        throw new PreviewSharedPreparationDeferred(Date.now() + 1000, { phase: 'publish-mkdir', blocker: task.forcePreparation ? 'missing' : cause.blocker || 'response-timeout',
          processPhase: cause.phase, requestId: cause.requestId, blockedBy: cause.blockedBy })
      }
      options.appendStartupLog(`preview cache publish mkdir dropped: ${dirname(sharedOutputPath)}, ${errorMessage(mkdirResult.error)}`)
      return
    }
    if (!current(task)) return
    const lock = await guarded(() => acquirePublishLock(lockPath))
    if (!lock) {
      stats.lockBusy += 1
      return
    }

    try {
      let expired = false
      let publishedBytes: Buffer | undefined
      const result = await withPhysicalIoCompletion(() => options.withIoDeadlineResult(`preview-cache-publish:${sharedOutputPath}`, () => guarded(async () => {
        if (!current(task)) throw new Error('preview publish cancelled')
        if (await pathExists(sharedOutputPath)) return 'exists' as const
        // Publish a stable local byte snapshot. The image and its checksum use
        // these exact bytes, avoiding two additional reads of the shared PNG.
        const bytes = await localFs.readFile(row.localOutputPath)
        if (!isCompletePreviewPng(bytes)) throw new Error('preview publish invalid local PNG')
        await fsp.writeFile(tmpPath, bytes)
        publishedBytes = bytes
        if (await pathExists(sharedOutputPath)) return 'exists-after-copy' as const
        if (expired || !current(task)) throw new Error('preview publish expired')
        await lock.rename(tmpPath, sharedOutputPath)
        return 'published' as const
      }), publishTimeoutMs()).then(result => { expired = !result.ok; return result }))

      await withoutSharedIoSignal(() => fsp.unlink(tmpPath)).catch(async error => { await awaitPhysicalIoClose(error) })
      if (!current(task)) return
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
        if (options.writeSharedPreviewCacheMeta) await guarded(async () => options.writeSharedPreviewCacheMeta?.(sharedOutputPath, row, publishedBytes))
          .then(() => {
            stats.metaWritten += 1
          })
          .catch(async (error) => {
            await awaitPhysicalIoClose(error)
            stats.checksumMismatch += 1
            options.appendStartupLog(`preview cache publish meta failed: ${sharedOutputPath}, ${errorMessage(error)}`)
          })
        if (!current(task)) return
        metaValidation = await options.validateSharedPreviewCacheMeta?.(sharedOutputPath, row, publishedBytes).catch(async (error): Promise<PreviewCacheMetaValidationResult> => { await awaitPhysicalIoClose(error); return { status: 'invalid', message: errorMessage(error) } }) || null
        if (metaValidation && metaValidation.status !== 'ok') {
          shouldWriteSharedIndex = false
          manifestEvent = 'meta-mismatch'
          stats.checksumMismatch += 1
          stats.indexSkipped += 1
        }
      } else {
        stats.skippedExisting += 1
        if (!current(task)) return
        metaValidation = await options.validateSharedPreviewCacheMeta?.(sharedOutputPath, row).catch(async (error): Promise<PreviewCacheMetaValidationResult> => { await awaitPhysicalIoClose(error); return { status: 'invalid', message: errorMessage(error) } }) || null
        if (metaValidation && (metaValidation.status === 'invalid' || metaValidation.status === 'mismatch')) {
          manifestEvent = 'meta-mismatch'
          shouldWriteSharedIndex = false
          stats.checksumMismatch += 1
          stats.indexSkipped += 1
          options.appendStartupLog(`preview cache publish existing meta mismatch: ${sharedOutputPath}, ${metaValidation.status}${metaValidation.message ? `, ${metaValidation.message}` : ''}`)
        }
      }

      if (!current(task)) return
      if (options.appendSharedPreviewCacheManifest) await guarded(async () => options.appendSharedPreviewCacheManifest?.(storage, row, sharedOutputPath, manifestEvent, metaValidation))
        .then(() => {
          stats.manifestWritten += 1
        })
        .catch(async (error) => {
          await awaitPhysicalIoClose(error)
          options.appendStartupLog(`preview cache publish manifest failed: ${sharedOutputPath}, ${errorMessage(error)}`)
        })

      if (shouldWriteSharedIndex && current(task)) {
        await guarded(() => options.writePreviewCacheIndex(storage, row.previewKey, {
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
        })).catch(async (error) => {
          await awaitPhysicalIoClose(error)
          if (['ENOENT', 'ENOTDIR'].includes((error as { code?: string })?.code || (error as { reason?: string })?.reason || '')) throw error
          options.appendStartupLog(`preview cache publish index failed: ${sharedOutputPath}, ${errorMessage(error)}`)
        })
      }
    } finally {
      await withoutSharedIoSignal(() => lock.release())
      await withoutSharedIoSignal(() => fsp.unlink(tmpPath)).catch(async error => { await awaitPhysicalIoClose(error) })
      logStats()
    }
  }

  function pump(): void {
    if (timer) clearTimeout(timer)
    timer = null
    for (const [key, task] of queue) {
      if (!current(task) || task.expiresAt <= Date.now()) {
        queue.delete(key)
        evidence(task.rootId, { phase: 'publication', blocker: current(task) ? 'optional-publication-expired' : 'generation-changed' })
      }
    }
    while (!isApplicationClosing() && active < publishMaxInFlight() && queue.size) {
      const runningRoots = new Set([...inFlight.values()].map(rootKey))
      const first = [...queue].find(([, task]) => !runningRoots.has(rootKey(task)) && Math.max(task.notBefore, rootRetryAt.get(rootKey(task)) || 0) <= Date.now())
      if (!first) break
      const [key, task] = first
      queue.delete(key)
      inFlight.set(key, task)
      active += 1
      withPhysicalIoCompletion(() => withSharedIoPriority('background', () => withSharedIoQueueTimeout(250, () => withSharedIoSignal(task.controller.signal, () => publishOne(task)))))
        .catch((error) => {
          const code = (error as { code?: string; reason?: string })?.code || (error as { reason?: string })?.reason
          // A missing cache parent can be recreated safely before a new lock.
          // An existing image is never rewritten on a retry.
          if ((code === 'ENOENT' || code === 'ENOTDIR') && !task.forcePreparation) task.forcePreparation = true
          const deferred = error instanceof PreviewSharedPreparationDeferred ? error : task.forcePreparation && (code === 'ENOENT' || code === 'ENOTDIR')
            ? new PreviewSharedPreparationDeferred(Date.now() + 1000, { phase: 'publish-lock', blocker: 'missing' }) : null
          if (deferred && current(task) && task.expiresAt > Date.now()) {
            task.notBefore = deferred.retryAt
            rootRetryAt.set(rootKey(task), deferred.retryAt)
            queue.set(key, task)
            if (!deferred.reported) evidence(task.rootId, deferred.detail)
          } else if (deferred) evidence(task.rootId, { phase: 'publication', blocker: 'optional-publication-expired' })
          else options.appendStartupLog(`preview cache publish failed: ${errorMessage(error)}`)
        })
        .finally(() => {
          // The outer physical scope finishes before either ownership is freed.
          inFlight.delete(key)
          active = Math.max(0, active - 1)
          for (const root of rootRetryAt.keys()) if (![...queue.values(), ...inFlight.values()].some(value => rootKey(value) === root)) rootRetryAt.delete(root)
          pump()
        })
    }
    if (active < publishMaxInFlight()) schedulePump()
    resolveIdle()
  }

  function enqueuePreviewCachePublish(localStorage: PreviewCacheStorage, row: PreviewCachePublishRow): void {
    if (cacheMaintenancePending() || isApplicationClosing()) return
    const sharedStorage = options.previewCacheStorageToShared(localStorage)
    if (!sharedStorage?.rootPath) return
    const state = getStartupPathRootState(sharedStorage.rootPath)
    const key = `${state.rootId}:${state.generation}:${row.previewKey}`
    if (queue.has(key) || inFlight.has(key)) {
      stats.coalesced += 1
      logStats()
      return
    }
    queue.set(key, { storage: { ...sharedStorage }, row: { ...row }, rootId: state.rootId, generation: state.generation,
      epoch: applicationWorkEpoch(), expiresAt: Date.now() + MAX_PENDING_MS, notBefore: Date.now() + publishDelayMs(), forcePreparation: false, controller: new AbortController() })
    while (queue.size > MAX_PENDING_ROWS) {
      const oldest = queue.entries().next().value!
      queue.delete(oldest[0]); evidence(oldest[1].rootId, { phase: 'publication', blocker: 'queue-capacity' })
    }
    stats.queued += 1
    schedulePump()
    logStats()
  }

  function retire(): void {
    if (timer) clearTimeout(timer)
    timer = null
    queue.clear(); rootRetryAt.clear()
    for (const task of inFlight.values()) task.controller.abort()
    resolveIdle()
  }
  onApplicationClosing(retire)
  registerCacheMaintenanceParticipant({ pause: async () => {
    retire()
    if (active) await new Promise<void>(resolve => idleWaiters.push(resolve))
  } })
  return {
    enqueuePreviewCachePublish,
    logStats,
    whenIdle: () => active || queue.size ? new Promise<void>(resolve => idleWaiters.push(resolve)) : Promise.resolve(),
  }
}
