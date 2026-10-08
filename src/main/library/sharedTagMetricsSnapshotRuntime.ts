import type { FontMetricsResult } from '../../shared/types'
import { isApplicationClosing, onApplicationClosing } from '../app/shutdownCoordinatorRuntime'
import { getStartupPathRootState } from '../path/startupPathAvailabilityRuntime'
import { withSharedIoPriority } from '../path/sharedFileSystemRuntime'
import { createFontQueryTask, type FontQueryTask } from './fontQueryTaskRuntime'

// One demand starts at most one attempt for its exact revision. Local metrics
// never await network binding reads, and unavailable is never an empty count.
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
  let snapshot: { counts: Record<string, number>; key: string; roots: string } | undefined
  let task: FontQueryTask<void> | undefined
  let demanded = false, stopped = false
  const rootsKey = () => JSON.stringify(roots)
  const revisionKey = () => JSON.stringify([generation, options.revision(), roots.map(root => {
    const state = getStartupPathRootState(root)
    return [state.rootId, state.generation, state.state]
  })])
  function pump(): void {
    if (stopped || isApplicationClosing() || task || !demanded) return
    demanded = false
    if (attempted === revisionKey()) return
    attempted = revisionKey()
    const version = generation, tagRevision = options.revision()
    const own: FontQueryTask<void> = createFontQueryTask(async () => withSharedIoPriority('background', async () => {
      const nextRoots = [...new Set(await options.roots())].sort()
      if (version !== generation || tagRevision !== options.revision() || stopped) return
      roots = nextRoots; rootsGeneration = version
      const key = revisionKey(), rootSet = rootsKey()
      attempted = key
      const counts = await options.read()
      if (!counts || own.controller.signal.aborted || stopped || key !== revisionKey()) return
      if (Object.values(counts).some(count => !Number.isSafeInteger(count) || count < 0)) throw new Error('Invalid shared tag count receipt')
      const changed = !snapshot || snapshot.roots !== rootSet || JSON.stringify(snapshot.counts) !== JSON.stringify(counts)
      snapshot = { counts: { ...counts }, key, roots: rootSet }
      if (changed) options.changed?.(++notificationRevision)
    }))
    task = own
    void own.pending.catch(error => {
      if (!own.controller.signal.aborted && !stopped) {
        try { options.appendLog(`shared tag counts retained: ${String(error)}`) } catch { /* Diagnostic only. */ }
      }
    }).finally(() => {
      if (task === own) task = undefined
      // Only a distinct incoming request can demand another attempt.
      pump()
    })
  }
  function invalidate(): void { generation++; demanded = false; task?.controller.abort() }
  // A cancelled shutdown resumes this owner; only dispose is terminal.
  const removeClosingListener = onApplicationClosing(invalidate)
  return {
    invalidate,
    apply(metrics: FontMetricsResult): FontMetricsResult {
      const key = revisionKey()
      if (!stopped && attempted !== key) { demanded = true; pump() }
      const current = snapshot?.key === key
      const status = current ? 'current' : task ? 'refreshing' : 'unavailable'
      if (!snapshot || rootsGeneration !== generation || snapshot.roots !== rootsKey()) return { ...metrics, sharedTagCountsStatus: status }
      const sharedTagCounts = { ...(current ? Object.fromEntries(Object.keys(metrics.sharedTagCounts || {}).map(tag => [tag, 0])) : metrics.sharedTagCounts), ...snapshot.counts }
      return { ...metrics, sharedTagCounts, sharedTagCountsStatus: status, tagCounts: { ...sharedTagCounts, ...metrics.localTagCounts } }
    },
    async dispose(): Promise<void> {
      stopped = true; demanded = false; removeClosingListener(); task?.controller.abort()
      await task?.pending.catch(() => undefined)
    },
  }
}
