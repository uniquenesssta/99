import { createCacheCleanupRuntime } from './scan-storage/cacheCleanupRuntime'
import { createCacheStatsRuntime } from './scan-storage/cacheStatsRuntime'
import { createCacheWindowsHiddenRuntime } from './scan-storage/cacheWindowsHiddenRuntime'
import { createRootIndexStorageRuntime } from './scan-storage/rootIndexStorageRuntime'
import { createRootPreviewManifestRuntime } from './scan-storage/rootPreviewManifestRuntime'
import { createScanCacheJsonRuntime } from './scan-storage/scanCacheJsonRuntime'
import type { ScanCacheStorageRuntimeOptions } from './scan-storage/scanCacheStorageTypes'

export type { PreviewStorage,RootIndexStorage,ScanCacheStorageRuntimeOptions } from './scan-storage/scanCacheStorageTypes'

export function createScanCacheStorageRuntime(options: ScanCacheStorageRuntimeOptions) {
  const jsonRuntime = createScanCacheJsonRuntime(options)
  const hiddenRuntime = createCacheWindowsHiddenRuntime(options)
  const rootIndexStorageRuntime = createRootIndexStorageRuntime(options, {
    readScanCacheFile: jsonRuntime.readScanCacheFile,
    hideDirectoryOnWindows: hiddenRuntime.hideDirectoryOnWindows
  })
  const previewManifestRuntime = createRootPreviewManifestRuntime(options)
  const statsRuntime = createCacheStatsRuntime(options, {
    readScanCacheFile: jsonRuntime.readScanCacheFile
  })
  const cleanupRuntime = createCacheCleanupRuntime(options, {
    getCacheStats: statsRuntime.getCacheStats
  })

  return {
    ...jsonRuntime,
    ...rootIndexStorageRuntime,
    ...hiddenRuntime,
    ...previewManifestRuntime,
    getCacheStats: statsRuntime.getCacheStats,
    ...cleanupRuntime
  }
}
