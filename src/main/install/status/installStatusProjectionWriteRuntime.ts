import type { FontItem } from '../../../shared/types'
import type { InstallStatusRuntime } from '../installStatusRuntime'

// All production status writers, including detail recheck and old queued jobs,
// settle their durable state and current merged projection through this owner.
export function createInstallStatusProjectionWriteRuntime(options: {
  saveInstallStatusIndex: InstallStatusRuntime['saveInstallStatusIndex']
  syncMergedIndexAfterInstallStatusRefresh: (roots: string[], items?: FontItem[]) => Promise<void>
}) {
  async function saveInstallStatusIndex(...args: Parameters<InstallStatusRuntime['saveInstallStatusIndex']>): Promise<void> {
    await options.saveInstallStatusIndex(...args)
    const [results, itemsById] = args
    const items = [...itemsById.values()].filter(item => Object.hasOwn(results, item.id))
    if (items.length) await options.syncMergedIndexAfterInstallStatusRefresh([], items)
  }
  return { saveInstallStatusIndex, installStatusProjectionOwnedByWriter: true as const }
}
