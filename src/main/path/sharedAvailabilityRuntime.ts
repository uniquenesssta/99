import { sharedIoResourceKeysSnapshot } from '../rust-core/rustSharedIoCommandRuntime'
import type { SharedAvailability } from '../../shared/sharedAvailability'
import { readSharedRootCatalog, sharedCatalogRootId } from '../library/runtime/sharedRootCatalogRuntime'
import { getStartupPathRootState } from './startupPathAvailabilityRuntime'

// Borrow the existing local handle. This endpoint reads only local DB/memory;
// initialization and recovery probes belong to the explicit background owner.
export function createSharedAvailabilityReader(openLibraryDb: () => Promise<unknown>): () => Promise<SharedAvailability> {
  return async () => {
    const db = await openLibraryDb() as { prepare: (sql: string) => { all: () => unknown[]; get: (key: string) => unknown } }
    const folders = (db.prepare('SELECT path FROM folders ORDER BY sort_order').all() as Array<{path: string}>).map(row => row.path)
    const tags = (db.prepare('SELECT name FROM tags ORDER BY sort_order').all() as Array<{name: string}>).map(row => row.name)
    const catalog = readSharedRootCatalog(db, tags)
    const roots = folders.map(path => {
      const resourceKeys = sharedIoResourceKeysSnapshot([path])
      return { ...getStartupPathRootState(path), path, resourceKeys, tags: catalog.roots.find(root => root.rootId === sharedCatalogRootId(path))?.tags || [] }
    })
    return { roots, tags, unattributedTags: catalog.unattributedTags }
  }
}
