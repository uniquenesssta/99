import { cacheMaintenancePending, registerCacheMaintenanceParticipant } from '../../maintenance/cacheMaintenanceCoordinator'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { applicationWorkEpoch, isApplicationClosing, onApplicationClosing } from '../../app/shutdownCoordinatorRuntime'
import { getStartupPathRootState, withStartupPathRootGuard } from '../../path/startupPathAvailabilityRuntime'
import { isIoDeadlineTimeout, previewCacheQueryTimeoutMs, withIoDeadlineResult, withPhysicalIoCompletion } from '../../path/ioDeadlineRuntime'
import { sharedFileSystem as fsp, withSharedIoPriority, withSharedIoQueueTimeout, withSharedIoSignal } from '../../path/sharedFileSystemRuntime'
import { applicationSharedIoProcessRuntime } from '../../path/sharedIoProcessRuntime'
import { sharedIoAccesses, sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime'
import type { PreviewRuntimeOptions } from './previewRuntimeTypes'
import { withSharedIoObservation, type SharedIoObservation } from '../../path/sharedIoSchedulingScope'

export type PreviewPreparationEvidence = {
  phase: string
  blocker: string
  processPhase?: 'preparing' | 'queued' | 'executing'
  requestId?: number
  blockedBy?: number
}
export class PreviewSharedPreparationDeferred extends Error {
  reported = false
  constructor(readonly retryAt: number, readonly detail: PreviewPreparationEvidence) {
    super(`Optional preview preparation deferred: ${detail.blocker}`)
    this.name = 'PreviewSharedPreparationDeferred'
  }
}

const RETRY_MS = 1000
const READY_TTL_MS = 30000
const MAX_ROOTS = 128
const boundedId = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
const failureCode = (error: unknown) => {
  const value = error as { code?: string; reason?: string } | null
  return value?.code || value?.reason || ''
}
export function previewPreparationRetryable(error: unknown): boolean {
  return isIoDeadlineTimeout(error) || ['ENOENT', 'ENOTDIR', 'timeout', 'queue-timeout', 'queue-full'].includes(failureCode(error))
}

// Log only controlled categories and numeric process IDs. No paths, font names,
// arbitrary exception text or request arguments enter this bounded evidence.
export function createPreviewPreparationEvidenceLogger(append: (message: string) => void) {
  let samples = 0
  const reported = new Set<string>()
  return (rootId: string, detail: PreviewPreparationEvidence): void => {
    const rootHash = createHash('sha256').update(rootId.toLowerCase()).digest('hex').slice(0, 20)
    const category = (value: string) => /^[a-zA-Z-]{1,48}$/.test(value) ? value : 'unknown'
    const phase = category(detail.phase), blocker = category(detail.blocker)
    const processPhase = ['preparing', 'queued', 'executing'].includes(detail.processPhase || '') ? detail.processPhase : 'unknown'
    const key = `${rootHash}:${phase}:${blocker}`
    if (reported.has(key) || samples >= 128) return
    samples++; reported.add(key)
    try { append(`preview cache preparation: caller=shared-publisher, rootHash=${rootHash}, phase=${phase}, blocker=${blocker}, processPhase=${processPhase}, request=${boundedId(detail.requestId) || 'none'}, blockedBy=${boundedId(detail.blockedBy) || 'none'}`) } catch { /* Diagnostics cannot change ownership. */ }
  }
}

type Options = Pick<PreviewRuntimeOptions, 'rootPreviewCacheDir' | 'rootPreviewImageDir' | 'rootPreviewDbPath' | 'hideDirectoryOnWindows' | 'writeRootPreviewCacheManifest' | 'appendStartupLog'> & {
  ensureRootAvailable: (root: string) => Promise<boolean>
}
type Entry = {
  rootId: string
  generation: number
  epoch: number
  revision: number
  controller: AbortController
  task?: Promise<boolean>
  readyUntil: number
  retryAt: number
  failure?: PreviewPreparationEvidence
  unavailableUntil: number
}

export function createPreviewSharedPreparationRuntime(options: Options) {
  const entries = new Map<string, Entry>()
  const evidence = createPreviewPreparationEvidenceLogger(options.appendStartupLog)
  let revision = 0
  function invalidate(): void {
    revision++
    for (const [key, entry] of entries) {
      entry.controller.abort()
      // A retired physical owner cannot be erased by a new generation.
      if (!entry.task) entries.delete(key)
    }
  }
  onApplicationClosing(invalidate)
  registerCacheMaintenanceParticipant({ pause: async () => {
    invalidate()
    await Promise.allSettled([...entries.values()].flatMap(entry => entry.task ? [entry.task] : []))
  } })

  async function ensurePrepared(root: string, force = false): Promise<boolean> {
    if (cacheMaintenancePending() || isApplicationClosing()) return false
    const state = getStartupPathRootState(root), now = Date.now()
    let entry = entries.get(state.rootId)
    if (entry?.task) {
      if (entry.generation === state.generation && entry.revision === revision) return entry.task
      entry.controller.abort()
      await entry.task.catch(() => false)
      if (cacheMaintenancePending() || isApplicationClosing()) return false
      return ensurePrepared(root, force)
    }
    if (entry && (entry.generation !== state.generation || entry.revision !== revision || entry.epoch !== applicationWorkEpoch())) {
      entries.delete(state.rootId); entry = undefined
    }
    if (entry?.retryAt && entry.retryAt > now) throw Object.assign(new PreviewSharedPreparationDeferred(entry.retryAt, entry.failure!), { reported: true })
    // Reusing a prepared directory performs no writes and needs no write admission.
    if (!force && entry && entry.readyUntil > now && state.state === 'online') return true
    if (entry?.unavailableUntil && entry.unavailableUntil > now) return false
    if (!entry) {
      for (const [key, old] of entries) if (!old.task && Math.max(old.readyUntil, old.retryAt, old.unavailableUntil) <= now) entries.delete(key)
      if (entries.size >= MAX_ROOTS) {
        const detail = { phase: 'admission', blocker: 'preparation-capacity' }
        evidence(state.rootId, detail)
        throw new PreviewSharedPreparationDeferred(now + RETRY_MS, detail)
      }
      entry = { rootId: state.rootId, generation: state.generation, epoch: applicationWorkEpoch(), revision, controller: new AbortController(), readyUntil: 0, retryAt: 0, unavailableUntil: 0 }
      entries.set(state.rootId, entry)
    }
    // An expired attempt's aborted signal is never reused by a retry.
    entry.controller = new AbortController()
    const owner = entry
    if (force) owner.readyUntil = 0
    const current = () => {
      const latest = getStartupPathRootState(root)
      return !isApplicationClosing() && !owner.controller.signal.aborted && applicationWorkEpoch() === owner.epoch
        && owner.revision === revision && latest.generation === owner.generation && latest.rootId === owner.rootId
    }
    const assertCurrent = () => { if (!current()) throw Object.assign(new Error('Preview preparation owner retired'), { reason: 'stale-generation' }) }
    const cacheDir = options.rootPreviewCacheDir(root), imageDir = options.rootPreviewImageDir(root), dbPath = options.rootPreviewDbPath(root)
    let phase = 'admission', observed: unknown
    let observation: SharedIoObservation = { phase: 'preparing' }
    const task = withPhysicalIoCompletion(() => withSharedIoPriority('background', () => withSharedIoQueueTimeout(250, () => withSharedIoSignal(owner.controller.signal, async () => {
      assertCurrent()
      // The snapshot is only a hint. Every actual filesystem admission retains
      // the scheduler's unmodified tree, alias, fairness and close barriers.
      const paths = [cacheDir, imageDir, dirname(dbPath)]
      const roots = await sharedIoResourceKeys(paths)
      assertCurrent()
      if (roots.length) {
        const accesses = await sharedIoAccesses(paths.map(path => ({ path, scope: 'file' as const, mode: 'write' as const })))
        assertCurrent()
        const admission = applicationSharedIoProcessRuntime().inspectAdmission({ roots, accesses, write: true, priority: 'background' })
        if (!admission.ready) {
          const detail: PreviewPreparationEvidence = { phase, blocker: admission.blocker || 'unknown', processPhase: 'queued', blockedBy: admission.blockedBy }
          throw new PreviewSharedPreparationDeferred(Date.now() + RETRY_MS, detail)
        }
      }
      if (!(await options.ensureRootAvailable(root))) {
        assertCurrent()
        if (getStartupPathRootState(root).state === 'offline') return false
        throw new PreviewSharedPreparationDeferred(Date.now() + RETRY_MS, { phase: 'availability', blocker: 'availability-unconfirmed' })
      }
      assertCurrent()
      if (getStartupPathRootState(root).state !== 'online') return false
      if (owner.readyUntil > Date.now()) return true
      await withStartupPathRootGuard(assertCurrent, async () => {
        for (const [label, operation] of [
          ['mkdir-images', () => fsp.mkdir(imageDir, { recursive: true })],
          ['mkdir-db', () => fsp.mkdir(dirname(dbPath), { recursive: true })],
          ['hide-dir', () => options.hideDirectoryOnWindows(cacheDir)],
          ['write-manifest', () => options.writeRootPreviewCacheManifest(cacheDir, root, 'root', dbPath, imageDir)],
        ] as Array<[string, () => Promise<unknown>]>) {
          assertCurrent(); phase = label
          observation = { phase: 'preparing' }
          const result = await withIoDeadlineResult(`preview-cache-${label}`, () => withSharedIoObservation(value => { observation = value },
            () => operation().catch(error => { observed = error; throw error })), Math.max(6000, previewCacheQueryTimeoutMs()))
          if (!result.ok) {
            if (result.timedOut) owner.controller.abort()
            throw result.error
          }
        }
      })
      assertCurrent()
      owner.readyUntil = Date.now() + READY_TTL_MS
      return true
    }))))
    owner.task = task.then(value => {
      if (!value) { owner.readyUntil = 0; owner.unavailableUntil = Date.now() + READY_TTL_MS }
      return value
    }, error => {
      owner.readyUntil = 0
      const cause = (observed || error) as { phase?: 'queued' | 'executing'; blocker?: string; requestId?: number; blockedBy?: number }
      const processPhase = cause.phase || observation.phase
      const detail: PreviewPreparationEvidence = error instanceof PreviewSharedPreparationDeferred ? error.detail : {
        phase, blocker: previewPreparationRetryable(error) ? (cause.blocker || (isIoDeadlineTimeout(error) ? 'response-timeout' : failureCode(error))) :
          ['EACCES', 'EPERM'].includes(failureCode(error)) ? 'access-denied' : failureCode(error) === 'stale-generation' ? 'generation-changed' : 'operation-failed',
        processPhase, requestId: boundedId(cause.requestId ?? observation.requestId), blockedBy: processPhase === 'queued' ? boundedId(cause.blockedBy ?? observation.blockedBy) : undefined,
      }
      evidence(owner.rootId, detail)
      if (error instanceof PreviewSharedPreparationDeferred || previewPreparationRetryable(error)) {
        owner.retryAt = Date.now() + RETRY_MS; owner.failure = detail
        throw Object.assign(new PreviewSharedPreparationDeferred(owner.retryAt, detail), { reported: true })
      }
      owner.unavailableUntil = Date.now() + READY_TTL_MS
      return false
    }).finally(() => {
      owner.task = undefined
      if (owner.revision !== revision || getStartupPathRootState(root).generation !== owner.generation || isApplicationClosing()) entries.delete(owner.rootId)
    })
    return owner.task
  }
  return { ensurePrepared, invalidate, whenIdle: async () => {
    while ([...entries.values()].some(entry => entry.task)) await Promise.allSettled([...entries.values()].flatMap(entry => entry.task ? [entry.task] : []))
  } }
}
