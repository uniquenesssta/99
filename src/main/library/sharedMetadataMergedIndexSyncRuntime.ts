import { resolve } from 'node:path'
import type { FontIndexChangePayload, FontItem } from '../../shared/types'

export interface SharedMetadataMergedIndexSyncRuntimeDeps {
  appendLog: (message: string) => void
  normalizePathForCacheCompare: (value: string) => string
  uniqueResolvedFolders: (folders: string[]) => string[]
  syncMergedIndexForRootIncremental: (rootPath: string, payload: FontIndexChangePayload, reason: string) => Promise<void>
  syncMergedIndexForRootSnapshot: (rootPath: string, reason: string) => Promise<void>
  openMetadataDb?: (root: string) => Promise<any | null>
  closeMetadataDb?: (db: any) => void
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
  const rootsByDepth = [...watchedFolders].sort((a, b) => b.length - a.length)
  for (const item of uniqueFonts(items)) {
    const root = rootsByDepth.find((folder) => itemPathInsideRoot(item.path || '', folder, normalize))
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
        source: 'shared-metadata',
        metadataFields: ['deleteProtected'],
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
        await syncSharedMetadataRootsToMergedIndex([root], `${reason}:incremental-failed`)
      }
    }
  }

  // These are locators only. The incremental owner reads committed metadata from
  // the source DB; renderer snapshots must never be written back into the index.
  async function syncSharedMetadataChangedIdsToMergedIndex(idsInput: string[], folders: string[], reason: string): Promise<void> {
    const ids = [...new Set(idsInput.filter(Boolean))]
    if (!ids.length) return
    const roots = deps.uniqueResolvedFolders(folders)
    const items: FontItem[] = []
    const found = new Set<string>()
    try {
      if (!deps.openMetadataDb) throw new Error('metadata-locator-reader-unavailable')
      for (const root of roots) {
        const db = await deps.openMetadataDb(root)
        if (!db) continue
        try {
          for (let start = 0; start < ids.length; start += 400) {
            const chunk = ids.slice(start, start + 400)
            const rows = db.prepare(`SELECT font_id, relative_path FROM font_metadata WHERE font_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as Array<{font_id: string; relative_path: string}>
            for (const row of rows) {
              if (!row.relative_path) continue
              const itemPath = resolve(root, row.relative_path)
              if (!itemPathInsideRoot(itemPath, root, deps.normalizePathForCacheCompare)) throw new Error('changed-id-path-outside-root')
              found.add(row.font_id)
              items.push({ id: row.font_id, path: itemPath } as FontItem)
            }
          }
        } finally { deps.closeMetadataDb?.(db) }
      }
      if (found.size !== ids.length) throw new Error(`changed-id-locator-incomplete:${found.size}/${ids.length}`)
    } catch (error) {
      deps.appendLog(`shared metadata sync fallback: reason=${reason}, cause=${String(error)}, committed=${ids.length}`)
      await syncSharedMetadataRootsToMergedIndex(roots, `${reason}:unknown-locators`)
      return
    }
    deps.appendLog(`shared metadata refresh scope: reason=${reason}, committed=${ids.length}, located=${items.length}, roots=${roots.length}, fontSnapshot=0`)
    await syncSharedMetadataItemsToMergedIndex(items, roots, reason)
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
    syncSharedMetadataChangedIdsToMergedIndex,
    syncSharedMetadataItemsToMergedIndex,
    syncSharedMetadataRootsToMergedIndex,
  }
}
