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
): Promise<string[]> {
  const committedFolders: string[] = []
  for (const context of rootCacheContexts) {
    const complete = context.scanListingComplete === true && !context.scanReadIncomplete
    if (context.cache.rebuildRequired) {
      // Any incomplete recovery scan retains the prior database and pointer.
      if (!complete || errors.length) {
        deps.appendStartupLog(`root index recovery publication deferred: root=${context.rootPath}, errors=${errors.length}`)
        continue
      }
      const entries = Object.fromEntries([...context.seenKeys].flatMap(key => context.nextEntries[key] ? [[key, context.nextEntries[key]]] : []))
      if (Object.keys(entries).length !== context.seenKeys.size) throw new Error('恢复索引条目不完整，已保留旧索引。')
      await deps.saveScanCacheFile(context.cachePath, { version: deps.fontScanCacheVersion, entries }, context.rootPath, context.storage)
      committedFolders.push(context.rootPath)
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

    if (complete) {
      for (const key of Object.keys(context.cache.entries || {})) {
        if (!context.seenKeys.has(key)) deletedKeys.push(key)
      }
    } else {
      deps.appendStartupLog(`scan incomplete source retained: storage=${context.storage}, previous=${Object.keys(context.cache.entries || {}).length}, seen=${context.seenKeys.size}, upserts=${changedEntries.length}, deletes=0`)
    }

    if (isRootIndexDbPath(context.cachePath)) {
      deps.appendStartupLog(`scan incremental manifest write: root=${context.rootPath}, storage=${context.storage}, upserts=${changedEntries.length}, deletes=${deletedKeys.length}, seen=${context.seenKeys.size}, previous=${Object.keys(context.cache.entries || {}).length}, skippedDirs=${context.directorySkipped}`)
      await deps.saveRootIndexSqliteChanges(context.cachePath, context.rootPath, context.storage, changedEntries, deletedKeys)
      if (complete) await directoryCacheRuntime.saveRootDirectorySignatures(context)
    } else if (changedEntries.length || deletedKeys.length) {
      const prunedEntries: Record<string, FontScanCacheEntry> = complete ? {} : { ...context.cache.entries }
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
    } else if (complete) {
      await directoryCacheRuntime.saveRootDirectorySignatures(context)
    }

    committedFolders.push(context.rootPath)
    await delayToEventLoop()
  }
  return committedFolders
}
