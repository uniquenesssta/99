import type { PhysicalFolderTreeResult,ScanResult } from '@shared/types'
import { scheduleDeferredInstallStatusRefresh } from './deferredInstallStatusRefreshRuntime'
import type { FontLibraryIndexActionRuntimeOptions,FontLibraryIndexSharedRuntime } from './fontLibraryIndexActionTypes'

export function createFontLibraryIndexSharedRuntime(options: FontLibraryIndexActionRuntimeOptions): FontLibraryIndexSharedRuntime {
  function invalidateDatabasePages(): void {
    options.setDatabasePageResult(null)
    options.setDatabaseQueryResult(null)
    options.setDatabaseFontMetrics(null)
    options.setDatabaseRefreshToken((value) => value + 1)
  }

  async function loadCacheStats(): Promise<void> {
    try {
      const stats = await options.hfm.getCacheStats()
      options.setCacheStats(stats)
    } catch {
      options.setCacheStats(null)
    }
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
