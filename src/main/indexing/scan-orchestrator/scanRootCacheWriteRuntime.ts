import { isRootIndexDbPath } from '../../cache/cachePaths'
import type { RootScanCacheContext } from '../../watcher/watchedFolderIndexRuntime'
import type { FontScanCacheEntry } from '../rootIndexRuntime'
import type { RootDirectoryCacheRuntime } from './rootDirectoryCacheRuntime'
import type { ScanOrchestratorDeps } from './scanOrchestratorTypes'
import { delayToEventLoop } from './scanOrchestratorUtils'

export async function writeRootScanCacheContexts(
  deps: ScanOrchestratorDeps,
  directoryCacheRuntime: Pick<RootDirectoryCacheRuntime, 'saveRootDirectorySignatures'>,
  rootCacheContexts: Iterable<RootScanCacheContext>,
): Promise<void> {
  for (const context of rootCacheContexts) {
    const changedEntries: Array<[string, FontScanCacheEntry]> = []
    const deletedKeys: string[] = []

    for (const key of context.seenKeys) {
      const nextEntry = context.nextEntries[key]
      if (!nextEntry) continue
      const oldEntry = context.cache.entries[key]
      if (!oldEntry || JSON.stringify(oldEntry) !== JSON.stringify(nextEntry)) changedEntries.push([key, nextEntry])
    }

    for (const key of Object.keys(context.cache.entries || {})) {
      if (!context.seenKeys.has(key)) deletedKeys.push(key)
    }

    if (isRootIndexDbPath(context.cachePath)) {
      deps.appendStartupLog(`scan incremental manifest write: root=${context.rootPath}, storage=${context.storage}, upserts=${changedEntries.length}, deletes=${deletedKeys.length}, seen=${context.seenKeys.size}, previous=${Object.keys(context.cache.entries || {}).length}, skippedDirs=${context.directorySkipped}`)
      await deps.saveRootIndexSqliteChanges(context.cachePath, context.rootPath, context.storage, changedEntries, deletedKeys)
      await directoryCacheRuntime.saveRootDirectorySignatures(context)
    } else if (changedEntries.length || deletedKeys.length) {
      const prunedEntries: Record<string, FontScanCacheEntry> = {}
      for (const key of context.seenKeys) {
        const entry = context.nextEntries[key]
        if (entry) prunedEntries[key] = entry
      }
      await deps.saveScanCacheFile(
        context.cachePath,
        { version: deps.fontScanCacheVersion, entries: prunedEntries },
        context.rootPath,
        context.storage,
      )
      await deps.writeRootCacheManifest(context.cacheDir, context.rootPath, context.storage, Object.keys(prunedEntries).length, context.cachePath)
    } else {
      await directoryCacheRuntime.saveRootDirectorySignatures(context)
    }

    await delayToEventLoop()
  }
}
