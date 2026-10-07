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
  errors: Array<{ path: string; message: string }> = [],
): Promise<void> {
  for (const context of rootCacheContexts) {
    if (context.cache.rebuildRequired) {
      // Any incomplete recovery scan retains the prior database and pointer.
      if (errors.length) {
        deps.appendStartupLog(`root index recovery publication deferred: root=${context.rootPath}, errors=${errors.length}`)
        continue
      }
      const entries = Object.fromEntries([...context.seenKeys].flatMap(key => context.nextEntries[key] ? [[key, context.nextEntries[key]]] : []))
      if (Object.keys(entries).length !== context.seenKeys.size) throw new Error('恢复索引条目不完整，已保留旧索引。')
      await deps.saveScanCacheFile(context.cachePath, { version: deps.fontScanCacheVersion, entries }, context.rootPath, context.storage)
      continue
    }
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
