import { cacheMaintenancePending, registerCacheMaintenanceParticipant } from '../../maintenance/cacheMaintenanceCoordinator'
import { applicationWorkEpoch, isApplicationClosing, onApplicationClosing } from '../../app/shutdownCoordinatorRuntime'
import { currentSharedIoSignal, withSharedIoSignal } from '../../path/sharedFileSystemRuntime'
import { withPhysicalIoCompletion } from '../../path/ioDeadlineRuntime'
import { SharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { type PreviewRenderLifetime, withPreviewRenderLifetime } from './previewRenderLifetimeRuntime'
import { previewFailure } from '../../../shared/previewFailure'

export type PreviewRenderTask<T> = {
  epoch: number
  controller: AbortController
  signal: AbortSignal
  pending: Promise<T>
  physicalCompletion: Promise<void>
  subscribers: number
  settled: boolean
  physicallySettled: boolean
}

function cancelled(owner?: PreviewRenderTask<unknown>): SharedIoProcessError {
  const error = new SharedIoProcessError(previewFailure('cancelled').message, 'not-started', 'cancelled')
  if (owner) error.closed = owner.physicalCompletion
  return error
}

export function assertPreviewRequestCurrent(epoch: number, signal = currentSharedIoSignal()): void {
  if (cacheMaintenancePending() || signal?.aborted || isApplicationClosing() || applicationWorkEpoch() !== epoch) throw cancelled()
}

// The map indexes the latest logical owner. This separate set retains every
// physical owner, including a retired epoch replaced by a waiting successor.
export function createPreviewRenderTaskRuntime() {
  const active = new Set<PreviewRenderTask<unknown>>()
  onApplicationClosing(() => { for (const owner of active) owner.controller.abort() })

  registerCacheMaintenanceParticipant({ pause: async () => {
    for (const owner of active) owner.controller.abort()
    await Promise.allSettled([...active].map(owner => owner.physicalCompletion))
  } })

  function reusable<T>(owner: PreviewRenderTask<T> | undefined): owner is PreviewRenderTask<T> {
    return !!owner && owner.epoch === applicationWorkEpoch() && !owner.signal.aborted && !owner.controller.signal.aborted
  }

  function create<T>(run: (lifetime: PreviewRenderLifetime) => Promise<T>, previous?: PreviewRenderTask<T>): PreviewRenderTask<T> {
    const controller = new AbortController()
    if (cacheMaintenancePending()) controller.abort()
    const owner: PreviewRenderTask<T> = { epoch: applicationWorkEpoch(), controller, signal: controller.signal, pending: undefined!, physicalCompletion: undefined!, subscribers: 0, settled: false, physicallySettled: false }
    active.add(owner)
    // A consumer's signal never owns shared work. Nested native owners inherit
    // the request's remaining budget, but have independent subscriber signals.
    owner.pending = withSharedIoSignal(controller.signal, () => withPreviewRenderLifetime(lifetime => withPhysicalIoCompletion(async () => {
      owner.signal = lifetime.signal
      if (previous && !previous.physicallySettled) {
        let detach = () => {}
        try {
          const aborted = new Promise<never>((_, reject) => {
            const abort = () => { try { lifetime.assertCurrent() } catch (error) { reject(error); return }; reject(cancelled()) }
            lifetime.signal.addEventListener('abort', abort, { once: true })
            detach = () => lifetime.signal.removeEventListener('abort', abort)
            if (lifetime.signal.aborted) abort()
          })
          // Only this new logical waiter may stop waiting. The previous owner
          // stays in active and keeps its pool/output slot until physical close.
          await Promise.race([previous.physicalCompletion, aborted])
        } finally { detach() }
      }
      lifetime.assertCurrent()
      return run(lifetime)
    }))).finally(() => { owner.settled = true })
    // A cancelled successor can settle before its predecessor closes. Carry
    // that barrier across any number of quit/resume cycles and map replacements.
    owner.physicalCompletion = Promise.allSettled([owner.pending, ...(previous ? [previous.physicalCompletion] : [])]).then(() => {
      owner.physicallySettled = true
      active.delete(owner)
    })
    void owner.pending.catch(() => undefined)
    return owner
  }

  async function join<T>(owner: PreviewRenderTask<T>, signal = currentSharedIoSignal()): Promise<T> {
    const epoch = applicationWorkEpoch()
    owner.subscribers++
    let detach = () => {}
    try {
      assertPreviewRequestCurrent(epoch, signal)
      let pending = owner.pending
      if (signal) {
        const aborted = new Promise<never>((_, reject) => {
          const abort = () => reject(cancelled(owner))
          signal.addEventListener('abort', abort, { once: true })
          detach = () => signal.removeEventListener('abort', abort)
          if (signal.aborted) abort()
        })
        pending = Promise.race([pending, aborted])
      }
      const value = await pending
      assertPreviewRequestCurrent(epoch, signal)
      return value
    } finally {
      detach()
      owner.subscribers--
      if (!owner.subscribers && !owner.settled) owner.controller.abort()
    }
  }

  return { create, join, reusable, whenIdle: async () => {
    while (active.size) await Promise.allSettled([...active].map(owner => owner.physicalCompletion))
  } }
}
