import { createFontLibraryCacheMaintenanceActionRuntime } from './actions/fontLibraryCacheMaintenanceActionRuntime'
import { createFontLibraryFolderCacheActionRuntime } from './actions/fontLibraryFolderCacheActionRuntime'
import type { FontLibraryIndexActionRuntime,FontLibraryIndexActionRuntimeOptions } from './actions/fontLibraryIndexActionTypes'
import { createFontLibraryIndexOperationActionRuntime } from './actions/fontLibraryIndexOperationActionRuntime'
import { createFontLibraryIndexSharedRuntime } from './actions/fontLibraryIndexSharedRuntime'
import { createFontLibrarySystemScanActionRuntime } from './actions/fontLibrarySystemScanActionRuntime'

export type { FontLibraryIndexActionRuntime,FontLibraryIndexActionRuntimeOptions } from './actions/fontLibraryIndexActionTypes'

export function createFontLibraryIndexActionRuntime(options: FontLibraryIndexActionRuntimeOptions): FontLibraryIndexActionRuntime {
  const sharedRuntime = createFontLibraryIndexSharedRuntime(options)
  const cacheMaintenanceRuntime = createFontLibraryCacheMaintenanceActionRuntime(options)
  const folderCacheRuntime = createFontLibraryFolderCacheActionRuntime(options, sharedRuntime)
  const indexOperationRuntime = createFontLibraryIndexOperationActionRuntime(options, sharedRuntime)
  const systemScanRuntime = createFontLibrarySystemScanActionRuntime(options, sharedRuntime)

  return {
    ...sharedRuntime,
    ...cacheMaintenanceRuntime,
    ...folderCacheRuntime,
    ...indexOperationRuntime,
    ...systemScanRuntime
  }
}
