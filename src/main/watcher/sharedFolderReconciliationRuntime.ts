import type { WatcherMetadataInventory } from './watched-folder-index/watchedFolderInventoryRuntime'
import type { SharedWatchRootStatus } from '../../shared/sharedWatchStatus'
import type { SharedIoProcessError } from '../path/sharedIoProcessRuntime'

export interface SharedFolderReconciliationOptions {
  collect: (signal: AbortSignal) => Promise<WatcherMetadataInventory>
  apply: (inventory: WatcherMetadataInventory, signal: AbortSignal, forceVerifyPaths: ReadonlySet<string>, onProgress: (pendingCount: number) => void) => Promise<boolean>
  isCurrent: () => boolean
  isBusy?: () => boolean
  log: (message: string) => void
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const MIN_INTERVAL_MS = 30000
const MAX_INTERVAL_MS = 300000
const EVENT_DELAY_MS = 1000

function sameInventory(left: WatcherMetadataInventory, right: WatcherMetadataInventory): boolean {
  if (left.files.size !== right.files.size) return false
  for (const [path, stat] of right.files) {
    const previous = left.files.get(path)
    if (!previous || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs) return false
  }
  return true
}

/** One root owns its timer, walk, apply and ACK. Observing files is not a commit. */
export function createSharedFolderReconciliationRuntime(options: SharedFolderReconciliationOptions) {
  const now = options.now || Date.now
  const setTimer = options.setTimer || setTimeout
  const clearTimer = options.clearTimer || clearTimeout
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let dueAt = 0
  let closed = false
  let active: Promise<void> | undefined
  let revision = 0
  let reconciledRevision = -1
  const pendingHints = new Map<string, number>()
  let committed: WatcherMetadataInventory | undefined
  let applyUnconfirmed = false
  let quietPasses = 0
  let failures = 0
  let retryAfter = 0
  let lastEventRetryAt = Number.NEGATIVE_INFINITY
  let lastCheckedAt: number | null = null
  let phase: SharedWatchRootStatus['phase'] = 'checking'
  let pendingCount: number | null = null
  let hintsOverflowed = false
  const current = () => !closed && !controller.signal.aborted && options.isCurrent()
  const log = (message: string) => { try { options.log(message) } catch { /* Logging is not an ACK. */ } }

  function schedule(delay: number): void {
    if (!current()) return
    const nextDue = now() + Math.max(0, delay, retryAfter - now())
    // Repeated notifications cannot postpone an already queued reconciliation.
    if (timer && dueAt <= nextDue) return
    if (timer) clearTimer(timer)
    dueAt = nextDue
    timer = setTimer(() => {
      timer = undefined
      if (!current()) return
      if (options.isBusy?.()) { schedule(2500); return }
      if (active) return
      const task = reconcile()
      active = task
      void task.finally(() => { if (active === task) active = undefined }).catch(() => undefined)
    }, Math.max(0, nextDue - now()))
    timer.unref?.()
  }

  async function reconcile(): Promise<void> {
    const startingRevision = revision
    const forceVerifyPaths = new Set([...pendingHints].filter(([, received]) => received <= startingRevision).slice(0, 64).map(([path]) => path))
    const startedAt = now()
    let delay = MIN_INTERVAL_MS
    try {
      phase = 'checking'
      pendingCount = null
      const observed = await options.collect(controller.signal)
      if (!current()) return
      const changed = forceVerifyPaths.size > 0 || applyUnconfirmed || !committed || !sameInventory(committed, observed)
      if (changed) {
        // Pending/partial/failed apply never advances the committed comparison.
        applyUnconfirmed = true
        phase = 'applying'
        if (!await options.apply(observed, controller.signal, forceVerifyPaths, count => {
          if (current() && revision === startingRevision && Number.isSafeInteger(count) && count >= 0) pendingCount = count
        })) throw new Error('index-apply-unconfirmed')
        if (!current()) return
        committed = observed
        applyUnconfirmed = false
        for (const path of forceVerifyPaths) if ((pendingHints.get(path) ?? Infinity) <= startingRevision) pendingHints.delete(path)
        quietPasses = 0
      } else quietPasses = Math.min(quietPasses + 1, 4)
      failures = 0
      retryAfter = 0
      reconciledRevision = startingRevision
      phase = 'idle'
      pendingCount = revision === startingRevision && pendingHints.size === 0 ? 0 : null
      if (revision === startingRevision && pendingHints.size === 0) lastCheckedAt = now()
      if (hintsOverflowed) { log('shared watcher hint budget exceeded; unmatched hints receive metadata reconciliation only'); hintsOverflowed = false }
      delay = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS * 2 ** quietPasses, (now() - startedAt) * 4))
      log(`shared watcher reconciled: files=${observed.files.size}, changed=${changed}, elapsedMs=${Math.max(0, now() - startedAt)}, nextMs=${revision !== startingRevision || pendingHints.size > 0 ? EVENT_DELAY_MS : delay}`)
    } catch (error) {
      // The request may reject on cancellation before its isolated process closes.
      // Retire this root only after that physical owner releases its OS resources.
      const sharedError = error && typeof error === 'object' && (error as SharedIoProcessError).sharedIo === true ? error as SharedIoProcessError : undefined
      const physicalClose = sharedError?.closed
      if (physicalClose) { try { await physicalClose } catch { /* Keep the original operation failure. */ } }
      if (!current()) return
      failures = Math.min(failures + 1, 5)
      quietPasses = 0
      delay = Math.min(MAX_INTERVAL_MS, MIN_INTERVAL_MS * 2 ** (failures - 1))
      retryAfter = now() + delay
      phase = options.isBusy?.() ? 'checking' : error instanceof Error && error.message === 'root-offline' ? 'offline' : 'error'
      pendingCount = null
      log(`shared watcher retained committed index: failures=${failures}, retryMs=${delay}, reason=${error instanceof Error ? error.message : 'reconciliation-failed'}`)
    } finally {
      if (current()) schedule((revision !== startingRevision || pendingHints.size > 0) && !failures ? EVENT_DELAY_MS : delay)
    }
  }

  return {
    start() { schedule(0) },
    requestReconciliation(deliveryObserved = false, paths: readonly string[] = []) {
      if (!current()) return
      revision += 1
      for (const path of paths) {
        const key = path.replaceAll('\\', '/').toLowerCase()
        if (!key || Buffer.byteLength(key) > 1024 || /[:\0]/.test(key) || key.split('/').some(part => !part || part === '.' || part === '..')) { hintsOverflowed = true; continue }
        if (pendingHints.has(key) || pendingHints.size < 256) pendingHints.set(key, revision)
        else hintsOverflowed = true
      }
      quietPasses = 0
      pendingCount = null
      // A real delivered change may signal reconnection. Admit one early retry per
      // 30 seconds; failure/heartbeat hints never defeat the offline backoff.
      if (deliveryObserved && failures && now() - lastEventRetryAt >= MIN_INTERVAL_MS) {
        lastEventRetryAt = now()
        retryAfter = now()
      }
      if (!active) schedule(EVENT_DELAY_MS)
    },
    close() {
      closed = true
      phase = 'stopped'
      pendingCount = null
      pendingHints.clear()
      controller.abort()
      if (timer) clearTimer(timer)
      timer = undefined
    },
    async whenIdle() { await active },
    status: () => ({ lastCheckedAt, phase, pendingCount, pending: !!active || applyUnconfirmed || revision !== reconciledRevision || pendingHints.size > 0 || failures > 0, failures, committed: !!committed }),
  }
}
