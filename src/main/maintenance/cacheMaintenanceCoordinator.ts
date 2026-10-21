import { AsyncLocalStorage } from 'node:async_hooks'
import { withSharedIoPriority } from '../path/sharedFileSystemRuntime'

export const CACHE_MAINTENANCE_PRIORITY = 1000
type Participant = { pause: () => Promise<void>; resume?: () => void | Promise<void> }
const participants = new Set<Participant>()
const ownership = new AsyncLocalStorage<{ active: boolean }>()
let pending = 0
let tail: Promise<void> = Promise.resolve()

export function cacheMaintenancePending(): boolean { return pending > 0 }
export function ownsCacheMaintenance(): boolean { return ownership.getStore()?.active === true }
export function registerCacheMaintenanceParticipant(participant: Participant): () => void {
  participants.add(participant)
  return () => { participants.delete(participant) }
}

// Raise admission before draining. A cancelled task retains its physical owner
// until pause resolves; a rebuild owns invalidation and scanning in one session.
export function runCacheMaintenance<T>(action: () => Promise<T>): Promise<T> {
  if (ownsCacheMaintenance()) return action()
  pending++
  const task = tail.then(async () => {
    const paused = [...participants]
    const owner = { active: true }
    try {
      const results = await Promise.allSettled(paused.map(async participant => participant.pause()))
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) throw failed.reason
      return await ownership.run(owner, () => withSharedIoPriority(CACHE_MAINTENANCE_PRIORITY, action))
    } finally {
      owner.active = false
      pending--
      // Resume hooks restore registrations; admission still blocks work when a
      // second maintenance request has already queued behind this one.
      await Promise.allSettled(paused.map(async participant => participant.resume?.()))
    }
  })
  tail = task.then(() => undefined, () => undefined)
  return task
}
