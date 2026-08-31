import type { FontIndexChangePayload, FontItem } from '../../shared/types'

export interface SharedMetadataMergedIndexSyncRuntimeDeps {
  appendLog: (message: string) => void
  normalizePathForCacheCompare: (value: string) => string
  uniqueResolvedFolders: (folders: string[]) => string[]
  syncMergedIndexForRootIncremental: (rootPath: string, payload: FontIndexChangePayload, reason: string) => Promise<void>
  syncMergedIndexForRootSnapshot: (rootPath: string, reason: string) => Promise<void>
  sendFontIndexChanged?: (payload: FontIndexChangePayload) => void
}

function itemPathInsideRoot(itemPath: string, rootPath: string, normalize: (value: string) => string): boolean {
  const path = normalize(itemPath)
  const root = normalize(rootPath)
  return path === root || path.startsWith(`${root}\\`) || path.startsWith(`${root}/`)
}

function uniqueFonts(items: FontItem[]): FontItem[] {
  const result = new Map<string, FontItem>()
  for (const item of items || []) {
    if (!item?.id || !item.path) continue
    result.set(item.id, item)
  }
  return Array.from(result.values())
}

function groupItemsByWatchedRoot(
  items: FontItem[],
  watchedFolders: string[],
  normalize: (value: string) => string,
): Map<string, FontItem[]> {
  const groups = new Map<string, FontItem[]>()
  for (const item of uniqueFonts(items)) {
    const root = watchedFolders.find((folder) => itemPathInsideRoot(item.path || '', folder, normalize))
    if (!root) continue
    const list = groups.get(root) || []
    list.push(item)
    groups.set(root, list)
  }
  return groups
}

export function createSharedMetadataMergedIndexSyncRuntime(
  deps: SharedMetadataMergedIndexSyncRuntimeDeps,
) {
  async function syncSharedMetadataItemsToMergedIndex(
    itemsInput: FontItem[],
    watchedFoldersInput: string[],
    reason: string,
    options: { emitIndexChanged?: boolean } = {},
  ): Promise<void> {
    const watchedFolders = deps.uniqueResolvedFolders(watchedFoldersInput || [])
    if (!watchedFolders.length) return
    const groups = groupItemsByWatchedRoot(itemsInput || [], watchedFolders, deps.normalizePathForCacheCompare)
    if (!groups.size) return

    const at = new Date().toISOString()
    for (const [root, items] of groups) {
      const payload: FontIndexChangePayload = {
        folder: root,
        at,
        upserts: uniqueFonts(items),
        deletes: [],
      }
      if (!payload.upserts.length) continue
      try {
        await deps.syncMergedIndexForRootIncremental(root, payload, reason)
        deps.appendLog(`shared metadata merged index incremental sync finished: reason=${reason}, root=${root}, upserts=${payload.upserts.length}`)
        if (options.emitIndexChanged && deps.sendFontIndexChanged) deps.sendFontIndexChanged(payload)
      } catch (error) {
        deps.appendLog(`shared metadata merged index incremental sync failed: reason=${reason}, root=${root}, ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  async function syncSharedMetadataRootsToMergedIndex(
    watchedFoldersInput: string[],
    reason: string,
  ): Promise<void> {
    const watchedFolders = deps.uniqueResolvedFolders(watchedFoldersInput || [])
    for (const root of watchedFolders) {
      try {
        await deps.syncMergedIndexForRootSnapshot(root, reason)
        deps.appendLog(`shared metadata merged index snapshot sync finished: reason=${reason}, root=${root}`)
      } catch (error) {
        deps.appendLog(`shared metadata merged index snapshot sync failed: reason=${reason}, root=${root}, ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return {
    syncSharedMetadataItemsToMergedIndex,
    syncSharedMetadataRootsToMergedIndex,
  }
}
