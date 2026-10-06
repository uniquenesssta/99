import type { PhysicalFolderTreeResult,ScanResult } from '@shared/types'
import { scheduleDeferredInstallStatusRefresh } from './deferredInstallStatusRefreshRuntime'
import type { FontLibraryIndexActionRuntimeOptions,FontLibraryIndexSharedRuntime } from './fontLibraryIndexActionTypes'

export function createFontLibraryIndexSharedRuntime(options: FontLibraryIndexActionRuntimeOptions): FontLibraryIndexSharedRuntime {
  const statsState = options.cacheStatsRequestState?.current || { active: null as Promise<void> | null, requested: 0 }

  function invalidateDatabasePages(): void {
    options.setDatabasePageResult(null)
    options.setDatabaseQueryResult(null)
    options.setDatabaseFontMetrics(null)
    options.setDatabaseRefreshToken((value) => value + 1)
  }

  function loadCacheStats(): Promise<void> {
    if (options.closingLifecycle.isClosing()) return Promise.resolve()
    statsState.requested += 1
    if (statsState.active) return statsState.active
    let current = true
    let closedRequested = 0
    const unsubscribe = options.closingLifecycle.subscribe(closing => {
      if (closing) { current = false; closedRequested = statsState.requested }
    })
    const task: Promise<void> = (async () => {
      // A burst shares the current physical request and at most one follow-up
      // per newly observed change. A superseded reply never overwrites stats.
      let observed: number
      do {
        observed = statsState.requested
        try {
          const stats = await options.hfm.getCacheStats()
          if (current && observed === statsState.requested) options.setCacheStats(stats)
        } catch {
          if (current && observed === statsState.requested) options.setCacheStats(null)
        }
      } while (current && !options.closingLifecycle.isClosing() && observed !== statsState.requested)
    })().finally(() => {
      unsubscribe()
      if (statsState.active === task) statsState.active = null
      if (!current && statsState.requested > closedRequested && !options.closingLifecycle.isClosing()) return loadCacheStats()
    })
    statsState.active = task
    return task
  }

  async function readPhysicalFolderTree(folders: string[]): Promise<PhysicalFolderTreeResult> {
    return options.hfm.listPhysicalFolderTree(folders)
  }

  async function finishIndexingWithoutFullInstallRefresh(statusText: string): Promise<void> {
    options.stopLazyInstallStatusDetect()
    options.knownInstallStatusIds.current.clear()
    invalidateDatabasePages()
    options.autoInstallStatusRefreshStartedRef.current = true
    scheduleDeferredInstallStatusRefresh({
      statusText,
      setStatus: options.setStatus,
      startRefresh: () => options.startBackgroundInstallStatusRefresh(statusText),
    })
  }

  function isCancelledScanResult(result: ScanResult): boolean {
    return !!result.stats?.cancelled
  }

  return {
    invalidateDatabasePages,
    loadCacheStats,
    readPhysicalFolderTree,
    finishIndexingWithoutFullInstallRefresh,
    isCancelledScanResult
  }
}
