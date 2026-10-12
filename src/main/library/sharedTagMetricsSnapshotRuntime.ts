import type { FontMetricsResult } from '../../shared/types'
import { isApplicationClosing, onApplicationClosing } from '../app/shutdownCoordinatorRuntime'
import { SharedMetadataSnapshotBusyError } from '../indexing/shared-metadata/sharedMetadataSnapshotFailureRuntime'
import { getStartupPathRootState } from '../path/startupPathAvailabilityRuntime'
import { withSharedIoPriority } from '../path/sharedFileSystemRuntime'
import { createFontQueryTask, type FontQueryTask } from './fontQueryTaskRuntime'

// Only positively identified native pin contention gets three retries after
// physical close. Local metrics never await these reads; unavailable is not zero.
const BUSY_RETRY_DELAYS_MS = [250, 1000, 3000] as const
export function createSharedTagMetricsSnapshotRuntime(options: {
  roots: () => Promise<string[]>
  revision: () => number
  read: () => Promise<Record<string, number> | undefined>
  changed?: (revision: number) => void
  appendLog: (message: string) => void
}) {
  let generation = 0, notificationRevision = 0, rootsGeneration = -1
  let roots: string[] = []
  let attempted: string | undefined
  let unavailableKey: string | undefined
  let busyOrigin: { key: string; rootToken: string; pinTarget: string } | undefined
  let attempts: { key: string; count: number } | undefined
  let retry: { key: string; timer: ReturnType<typeof setTimeout> } | undefined
  let snapshot: { counts: Record<string, number>; key: string; roots: string } | undefined
  let task: FontQueryTask<void> | undefined
  let demanded = false, stopped = false
  const log = (message: string) => { try { options.appendLog(message) } catch { /* Diagnostic only. */ } }
  const rootsKey = () => JSON.stringify(roots)
  const revisionKey = () => JSON.stringify([generation, options.revision(), roots.map(root => {
    const state = getStartupPathRootState(root)
    return [state.rootId, state.generation, state.state]
  })])
  function clearRetry(): void { if (retry) clearTimeout(retry.timer); retry = undefined }
  function pump(): void {
    if (stopped || isApplicationClosing() || task || !demanded) return
    demanded = false
    if (attempted === revisionKey()) return
    clearRetry()
    attempted = revisionKey()
    const version = generation, tagRevision = options.revision()
    let executionKey: string | undefined, busy: SharedMetadataSnapshotBusyError | undefined, attempt = 0
    const own: FontQueryTask<void> = createFontQueryTask(async () => withSharedIoPriority('background', async () => {
      const nextRoots = [...new Set(await options.roots())].sort()
      if (version !== generation || tagRevision !== options.revision() || stopped) return
      roots = nextRoots; rootsGeneration = version
      const key = revisionKey(), rootSet = rootsKey()
      executionKey = key; attempted = key
      attempts = { key, count: attempts?.key === key ? attempts.count + 1 : 1 }
      attempt = attempts.count
      const counts = await options.read()
      if (!counts || own.controller.signal.aborted || stopped || key !== revisionKey()) return
      if (Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('Invalid shared tag count receipt')
      const changed = !snapshot || snapshot.roots !== rootSet || JSON.stringify(snapshot.counts) !== JSON.stringify(counts)
      snapshot = { counts: { ...counts }, key, roots: rootSet }
      unavailableKey = undefined
      if (attempt > 1) log(`shared tag counts recovered: root=${busyOrigin?.key === key ? busyOrigin.rootToken : 'unconfirmed'}, pin=${busyOrigin?.key === key ? busyOrigin.pinTarget : 'unconfirmed'}, attempt=${attempt}, roots=${roots.length}, tags=${Object.keys(counts).length}`)
      busyOrigin = undefined
      // Recovery also changes unavailable -> current when membership is identical.
      if (changed || attempt > 1) {
        try { options.changed?.(++notificationRevision) }
        catch (notificationError) { log(`shared tag count status notification failed: ${String(notificationError)}`) }
      }
    }))
    task = own
    void own.pending.catch(error => {
      if (!own.controller.signal.aborted && !stopped && executionKey === revisionKey()) {
        const statusChanged = unavailableKey !== executionKey
        unavailableKey = executionKey
        if (error instanceof SharedMetadataSnapshotBusyError) {
          busy = error
          if (executionKey) busyOrigin = { key: executionKey, rootToken: error.rootToken, pinTarget: error.pinTarget }
        }
        log(`shared tag counts retained: ${String(error)}`)
        // Notify the current view once even when no further query is made. The
        // composition callback publishes metrics status; it does not invalidate us.
        if (statusChanged) {
          try { options.changed?.(++notificationRevision) }
          catch (notificationError) { log(`shared tag count status notification failed: ${String(notificationError)}`) }
        }
      }
    }).finally(() => {
      if (task === own) task = undefined
      // createFontQueryTask holds rejection until the original child.closed.
      if (busy && executionKey && executionKey === revisionKey() && !own.controller.signal.aborted && !stopped && !isApplicationClosing()) {
        const delay = BUSY_RETRY_DELAYS_MS[attempt - 1]
        if (delay !== undefined) {
          const key = executionKey
          const timer = setTimeout(() => {
            if (retry?.timer !== timer) return
            retry = undefined
            if (stopped || isApplicationClosing() || key !== revisionKey()) return
            attempted = undefined; demanded = true; pump()
          }, delay)
          retry = { key, timer }
          log(`shared tag counts retry scheduled: root=${busy.rootToken}, pin=${busy.pinTarget}, attempt=${attempt + 1}, delayMs=${delay}`)
        } else log(`shared tag counts retry exhausted: root=${busy.rootToken}, pin=${busy.pinTarget}, attempts=${attempt}`)
      }
      pump()
    })
  }
  function invalidate(): void { generation++; demanded = false; clearRetry(); task?.controller.abort() }
  // A cancelled shutdown resumes this owner; only dispose is terminal.
  const removeClosingListener = onApplicationClosing(invalidate)
  return {
    invalidate,
    apply(metrics: FontMetricsResult): FontMetricsResult {
      const key = revisionKey()
      if (retry && retry.key !== key) clearRetry()
      if (!stopped && attempted !== key) { demanded = true; pump() }
      const current = snapshot?.key === key
      const status = current ? 'current' : unavailableKey === key ? 'unavailable' : task ? 'refreshing' : 'unavailable'
      if (!snapshot || rootsGeneration !== generation || snapshot.roots !== rootsKey()) return { ...metrics, sharedTagCountsStatus: status }
      const sharedTagCounts = { ...(current ? Object.fromEntries(Object.keys(metrics.sharedTagCounts || {}).map(tag => [tag, 0])) : metrics.sharedTagCounts), ...snapshot.counts }
      return { ...metrics, sharedTagCounts, sharedTagCountsStatus: status, tagCounts: { ...sharedTagCounts, ...metrics.localTagCounts } }
    },
    async dispose(): Promise<void> {
      stopped = true; demanded = false; clearRetry(); removeClosingListener(); task?.controller.abort()
      await task?.pending.catch(() => undefined)
    },
  }
}
