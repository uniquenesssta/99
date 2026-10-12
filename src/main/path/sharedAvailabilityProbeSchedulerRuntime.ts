import { isApplicationClosing } from '../app/shutdownCoordinatorRuntime'
import { normalizeNativePathText } from './pathCanonicalizer'
import { win32 } from 'node:path'
import { ensureStartupPathRootAvailable, getStartupPathRootState, isStartupPathRootProbeDue, type StartupPathAvailabilityLogger } from './startupPathAvailabilityRuntime'

const CONFIGURATION_POLL_MS = 5000

type Options = {
  // This port must read the local folders table only, without normalization
  // that discovers mapped drives or touches configured roots.
  readRoots: () => Promise<string[]>
  appendLog?: StartupPathAvailabilityLogger
}

// One explicit application owner schedules initialization and recovery. Per-root
// identity, cooldown and in-flight ownership stay in startupPathAvailability.
export function createSharedAvailabilityProbeScheduler(options: Options) {
  let running = false
  let epoch = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading: Promise<void> | undefined
  let active: { path: string; controller: AbortController; promise: Promise<void> } | undefined
  let cursor = 0
  const lexicalKey = (path: string) => win32.normalize(normalizeNativePathText(path)).toLowerCase()

  function schedule(delay = CONFIGURATION_POLL_MS): void {
    if (!running || isApplicationClosing()) return
    if (timer && delay === 0) { clearTimeout(timer); timer = undefined }
    if (timer) return
    timer = setTimeout(() => { timer = undefined; void tick() }, delay)
    timer.unref?.()
  }

  function tick(): Promise<void> {
    if (!running || isApplicationClosing()) return Promise.resolve()
    if (reading) return reading
    const ticket = epoch
    const work = (async () => {
      try {
        const paths = [...new Map((await options.readRoots()).filter(Boolean).map(path => [lexicalKey(path), path])).values()]
        if (!running || epoch !== ticket || isApplicationClosing()) return
        // Keep polling local configuration during a held physical close. A
        // removed root cannot publish through its old scheduled owner.
        if (active && !paths.some(path => lexicalKey(path) === lexicalKey(active!.path))) active.controller.abort()
        if (active || !paths.length) return
        const identities = new Set<string>()
        for (let offset = 0; offset < paths.length; offset++) {
          const index = (cursor + offset) % paths.length
          const path = paths[index]
          const rootId = getStartupPathRootState(path).rootId
          if (identities.has(rootId)) continue
          identities.add(rootId)
          if (!isStartupPathRootProbeDue(path)) continue
          cursor = (index + 1) % paths.length
          const controller = new AbortController()
          const request = { path, controller, promise: Promise.resolve() }
          active = request
          request.promise = ensureStartupPathRootAvailable(path, options.appendLog, 'availability-background', { background: true, signal: controller.signal })
            .then(() => undefined, error => { options.appendLog?.(`shared availability scheduled probe failed: ${String(error)}`) })
            .finally(() => {
              if (active === request) active = undefined
              // Reuse the one configuration timer. No second recovery loop is
              // created by UI polling, watcher ticks or a cancelled quit.
              schedule(isStartupPathRootProbeDue(path) ? CONFIGURATION_POLL_MS : 0)
            })
          break
        }
      } catch (error) {
        options.appendLog?.(`shared availability local configuration read failed: ${String(error)}`)
      }
    })()
    reading = work.finally(() => { reading = undefined; schedule() })
    return reading
  }

  function start(): void {
    if (running || isApplicationClosing()) return
    running = true
    ++epoch
    schedule(0)
  }

  async function whenIdle(): Promise<void> {
    while (reading || active) await Promise.all([reading, active?.promise])
  }

  function stop(): Promise<void> {
    running = false
    ++epoch
    if (timer) clearTimeout(timer)
    timer = undefined
    active?.controller.abort()
    // A resumed application may already own new work by the time close arrives.
    // Stop waits only for the work captured from its own lifetime.
    return Promise.all([reading, active?.promise]).then(() => undefined)
  }

  return { start, stop, whenIdle }
}
