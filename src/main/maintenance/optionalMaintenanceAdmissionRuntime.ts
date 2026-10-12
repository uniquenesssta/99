import { awaitPhysicalIoClose } from '../path/ioDeadlineRuntime'
import { createHash } from 'node:crypto'
import { applicationWorkEpoch, isApplicationClosing, onApplicationClosing } from '../app/shutdownCoordinatorRuntime'
import { getStartupPathRootState } from '../path/startupPathAvailabilityRuntime'
import { withSharedIoPriority, withSharedIoSignal } from '../path/sharedFileSystemRuntime'

export type MaintenanceDeferral = {
  caller: string
  rootHash: string
  blocker: 'foreground' | 'unavailable' | 'generation-changed' | 'closing'
  phase: string
}
export class OptionalMaintenanceDeferred extends Error {
  constructor(readonly detail: MaintenanceDeferral) { super(`Optional maintenance deferred: ${detail.blocker}`) }
}
export type OptionalMaintenanceAdmissionOptions = {
  caller: string
  isForegroundBusy?: () => boolean
  appendStartupLog?: (message: string) => void
}

// One invocation owns its wait budget, signal and progress. It never probes a
// root, resets recovery backoff, or retries a submitted write. The availability
// owner is solely responsible for establishing/recovering online roots.
export function createOptionalMaintenanceAdmission(options: OptionalMaintenanceAdmissionOptions) {
  const epoch = applicationWorkEpoch()
  let waitedMs = 0
  const reported = new Set<string>()
  const controller = new AbortController()
  const rootGenerations = new Map<string, number>()
  const hash = (root?: string) => root ? createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 12) : 'local'
  function defer(blocker: MaintenanceDeferral['blocker'], phase: string, root?: string): never {
    const detail = { caller: options.caller, rootHash: hash(root), blocker, phase }
    const key = JSON.stringify(detail)
    // Evidence is bounded independently of the number of paths in a root.
    if (!reported.has(key) && reported.size < 32) {
      reported.add(key)
      options.appendStartupLog?.(`optional maintenance deferred: caller=${detail.caller}, rootHash=${detail.rootHash}, blocker=${blocker}, phase=${phase}`)
    }
    throw new OptionalMaintenanceDeferred(detail)
  }
  function assertCurrent(phase: string, root?: string): void {
    if (controller.signal.aborted || isApplicationClosing() || applicationWorkEpoch() !== epoch) defer('closing', phase, root)
    if (!root) return
    const state = getStartupPathRootState(root)
    if (state.state !== 'online') defer('unavailable', phase, root)
    const previous = rootGenerations.get(state.rootId)
    if (previous !== undefined && previous !== state.generation) defer('generation-changed', phase, root)
    rootGenerations.set(state.rootId, state.generation)
  }
  async function pause(ms: number): Promise<void> {
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve() }
      const timer = setTimeout(finish, ms)
      controller.signal.addEventListener('abort', finish, { once: true })
      if (controller.signal.aborted) finish()
    })
  }
  async function checkpoint(phase: string, root?: string): Promise<void> {
    assertCurrent(phase, root)
    await pause(0)
    while (options.isForegroundBusy?.()) {
      assertCurrent(phase, root)
      if (waitedMs >= 2000) defer('foreground', phase, root)
      await pause(100)
      waitedMs += 100
    }
    assertCurrent(phase, root)
  }
  async function run<T>(operation: () => Promise<T>): Promise<T> {
    const unsubscribe = onApplicationClosing(() => controller.abort())
    try {
      assertCurrent('admission')
      return await withSharedIoPriority('background', () => withSharedIoSignal(controller.signal, operation))
    } catch (error) {
      // Promise rejection is not physical process completion. Do not return a
      // continuation or allow fallback while an admitted write is still alive.
      await awaitPhysicalIoClose(error)
      throw error
    } finally { unsubscribe() }
  }
  return { checkpoint, assertCurrent, run }
}
