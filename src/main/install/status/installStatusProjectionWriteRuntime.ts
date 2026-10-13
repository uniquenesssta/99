import type { FontItem } from '../../../shared/types'
import type { InstallStatusRuntime } from '../installStatusRuntime'

// All production status writers, including detail recheck and old queued jobs,
// settle their durable state and current merged projection through this owner.
export function createInstallStatusProjectionWriteRuntime(options: {
  saveInstallStatusIndex: InstallStatusRuntime['saveInstallStatusIndex']
  syncMergedIndexAfterInstallStatusRefresh: (roots: string[], items?: FontItem[]) => Promise<void>
}) {
  let tail: Promise<void> = Promise.resolve()
  function saveInstallStatusIndex(...args: Parameters<InstallStatusRuntime['saveInstallStatusIndex']>): Promise<void> {
    // Persist + complete local authority reconciliation share one lane. A failed
    // projection leaves the source durable; the next reconciliation covers it as
    // well, and process startup rechecks local authority before exposing rows.
    const task = tail.catch(() => undefined).then(async () => {
      await options.saveInstallStatusIndex(...args)
      const [results, itemsById] = args
      const items = [...itemsById.values()].filter(item => Object.hasOwn(results, item.id))
      if (items.length) await options.syncMergedIndexAfterInstallStatusRefresh([], items)
    })
    tail = task.catch(() => undefined)
    return task
  }
  return { saveInstallStatusIndex, installStatusProjectionOwnedByWriter: true as const }
}
