import type fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { extname,resolve } from 'node:path'
import type { FontIndexChangePayload,FontItem } from '../../shared/types'
import { fileCacheSignature,isIgnoredInternalDirectoryName,isRootIndexDbPath } from '../cache/cachePaths'
import type { FontScanCacheEntry } from '../indexing/rootIndexRuntime'
import type { PendingFolderChange } from './folderWatcherRuntime'
import type { RootDirectorySignature, WatchedFolderIndexRuntime, WatchedFolderIndexRuntimeOptions, WatcherDeleteRecord } from './watched-folder-index/watchedFolderIndexTypes'
export type { RootDirectorySignature, RootScanCacheContext, RootScanCacheStorage, WatchedFolderIndexRuntime } from './watched-folder-index/watchedFolderIndexTypes'
import { directorySignatureMatches, watcherPathDepth, watcherPathIsInside, watcherRelativePath } from './watched-folder-index/watchedFolderPathRuntime'

export function createWatchedFolderIndexRuntime(options: WatchedFolderIndexRuntimeOptions): WatchedFolderIndexRuntime {
  function normalizePendingFolderChanges(changes: PendingFolderChange[]): PendingFolderChange[] {
    return Array.from(
      new Map(
        (changes || [])
          .map((change) => ({
            ...change,
            fileName: String(change.fileName || '').replace(/^[/\\]+/, ''),
          }))
          .filter((change) => change.fileName && !options.isIgnoredWatcherPath(change.fileName))
          .map(
            (change) =>
              [`${watcherRelativePath(change.fileName)}\0${change.eventType}`, change] as const,
          ),
      ).values(),
    ).sort((a, b) => watcherPathDepth(a.fileName) - watcherPathDepth(b.fileName))
  }

  async function computeWatchedDirectorySignature(dirPath: string): Promise<RootDirectorySignature | null> {
    try {
      const stat = await options.withGlobalIo('watch:stat-dir', () => fsp.stat(dirPath), {
        priority: 'normal',
        storagePath: dirPath,
      })
      if (!stat.isDirectory()) return null
      const entries = await options.withGlobalIo(
        'watch:read-dir',
        () => fsp.readdir(dirPath, { withFileTypes: true }),
        { priority: 'normal', storagePath: dirPath },
      )
      let fileCount = 0
      let dirCount = 0
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (
            entry.name === 'node_modules' ||
            entry.name.startsWith('.') ||
            isIgnoredInternalDirectoryName(entry.name)
          )
            continue
          dirCount += 1
        } else if (entry.isFile()) {
          fileCount += 1
        }
      }
      return { modifiedAt: stat.mtimeMs, fileCount, dirCount }
    } catch {
      return null
    }
  }

  async function activeRootIndexDbPath(rootPath: string): Promise<string | null> {
    const defaultDbPath = options.rootIndexDbPath(rootPath)
    const cacheDir = options.rootCacheDir(rootPath)
    const dbPath = await options.resolveActiveRootIndexDbPath(cacheDir, defaultDbPath).catch(() => defaultDbPath)
    if (await options.exists(dbPath)) return dbPath
    if (dbPath !== defaultDbPath && await options.exists(defaultDbPath)) return defaultDbPath
    return null
  }

  async function watcherChangeBatchLooksUnchanged(
    rootPath: string,
    changes: PendingFolderChange[],
  ): Promise<boolean> {
    const normalizedChanges = normalizePendingFolderChanges(changes)
    if (!normalizedChanges.length) return true

    const dbPath = await activeRootIndexDbPath(rootPath)
    if (!dbPath) return false

    if (options.runRustWatcherPreflight) {
      const rustResult = await options.runRustWatcherPreflight({
        rootPath,
        dbPath,
        extensions: Array.from(options.fontExtensions),
        changes: normalizedChanges.map((change) => ({
          eventType: change.eventType,
          fileName: watcherRelativePath(change.fileName),
        })),
      })
      if (rustResult) return rustResult.unchanged
    }

    const fontTargets: Array<{ relativePath: string; cacheKey: string }> = []
    const directoryTargets: Array<{ relativePath: string; signature: RootDirectorySignature }> = []

    for (const change of normalizedChanges) {
      if (String(change.eventType || '').toLowerCase() !== 'change') return false

      const targetPath = resolve(rootPath, change.fileName)
      let stat: fs.Stats
      try {
        stat = await options.withGlobalIo(
          'watch:preflight-stat',
          () => fsp.stat(targetPath),
          { priority: 'background', storagePath: targetPath },
        )
      } catch {
        return false
      }

      if (stat.isFile()) {
        if (!options.fontExtensions.has(extname(targetPath).toLowerCase())) return false
        const cacheKey = options.cacheKeyForRootFile(rootPath, targetPath)
        fontTargets.push({
          relativePath: cacheKey,
          cacheKey: fileCacheSignature(cacheKey, stat.size, stat.mtimeMs),
        })
        continue
      }

      if (stat.isDirectory()) {
        const signature = await computeWatchedDirectorySignature(targetPath)
        if (!signature) return false
        directoryTargets.push({
          relativePath: options.relativeDirectoryPathForRoot(rootPath, targetPath),
          signature,
        })
        continue
      }

      return false
    }

    if (!fontTargets.length && !directoryTargets.length) return true

    let db: any | null = null
    try {
      db = await options.openRootIndexDb(dbPath, rootPath, 'root', false)
      const entryStmt = db.prepare(
        'SELECT cache_key, status FROM entries WHERE relative_path = ? AND is_deleted = 0',
      )
      for (const target of fontTargets) {
        const row = entryStmt.get(target.relativePath) as { cache_key?: string; status?: string } | undefined
        if (!row || row.cache_key !== target.cacheKey) return false
        if (row.status !== 'ok' && row.status !== 'bad') return false
      }

      const dirStmt = db.prepare(
        'SELECT modified_at, file_count, dir_count FROM directories WHERE relative_path = ?',
      )
      for (const target of directoryTargets) {
        const row = dirStmt.get(target.relativePath) as
          | { modified_at?: number; file_count?: number; dir_count?: number }
          | undefined
        if (!row) return false
        if (
          !directorySignatureMatches(
            {
              modifiedAt: Number(row.modified_at || 0),
              fileCount: Number(row.file_count || 0),
              dirCount: Number(row.dir_count || 0),
            },
            target.signature,
          )
        )
          return false
      }

      return true
    } catch {
      return false
    } finally {
      if (db) options.closeSqliteDb(db)
    }
  }

  async function applyWatchedFolderChangesToIndex(changes: PendingFolderChange[]): Promise<FontIndexChangePayload> {
    const first = changes[0]
    const rootPath = resolve(first?.folder || '')
    const payload: FontIndexChangePayload = {
      folder: rootPath,
      at: new Date().toISOString(),
      upserts: [],
      deletes: [],
      errors: [],
    }

    const normalizedChanges = normalizePendingFolderChanges(changes)
    if (!normalizedChanges.length) return payload

    const storage = await options.ensureRootScanCacheStorage(rootPath)
    const context = options.makeRootScanCacheContext(rootPath, storage)
    const directorySignatures = await options.readRootDirectorySignatures(context)
    const changedEntryMap = new Map<string, FontScanCacheEntry>()
    const deletedKeySet = new Set<string>()
    const processedDirectories: string[] = []

    const recordChangedEntry = (
      key: string,
      entry: FontScanCacheEntry | undefined,
      font: FontItem | null,
    ): void => {
      if (!entry) return
      deletedKeySet.delete(key)
      changedEntryMap.set(key, entry)
      if (font && entry.status === 'ok') payload.upserts.push(font)
    }

    const recordDelete = (item: WatcherDeleteRecord): void => {
      const key = item.relativePath
      changedEntryMap.delete(key)
      deletedKeySet.add(key)
      payload.deletes.push(item)
      delete context.cache.entries[key]
    }

    async function processFontFile(filePath: string): Promise<void> {
      const key = options.cacheKeyForRootFile(rootPath, filePath)
      const oldEntry = context.cache.entries[key]
      const font = await options.upsertFontIndexEntry(rootPath, filePath, context.cache)
      const newEntry = context.cache.entries[key]
      if (options.fontIndexEntryChanged(oldEntry, newEntry)) recordChangedEntry(key, newEntry, font)
    }

    async function processDirectory(targetPath: string): Promise<boolean> {
      const relativeDir = options.relativeDirectoryPathForRoot(rootPath, targetPath)
      const currentSignature = await computeWatchedDirectorySignature(targetPath)
      if (directorySignatureMatches(directorySignatures.get(relativeDir), currentSignature)) {
        options.appendStartupLog(
          `font index watcher skipped unchanged directory: ${rootPath} ${relativeDir || '.'}`,
        )
        return false
      }

      const errors = payload.errors || []
      const rows = await options.listFontFilesWithDirectoryCache(
        context,
        errors,
        undefined,
        undefined,
        targetPath,
      )
      const seenKeysInDirectory = new Set<string>()

      for (const row of rows) {
        const key = options.cacheKeyForRootFile(rootPath, row.file)
        seenKeysInDirectory.add(key)
        await processFontFile(row.file)
      }

      for (const [key, entry] of Object.entries(context.cache.entries || {})) {
        if (!options.cacheKeyInsideDirectory(key, relativeDir)) continue
        if (seenKeysInDirectory.has(key)) continue
        recordDelete(options.fontIndexDeleteRecord(rootPath, key, entry))
      }

      return true
    }

    for (const change of normalizedChanges) {
      const relativeName = watcherRelativePath(change.fileName)
      if (!relativeName) continue
      if (processedDirectories.some((dir) => watcherPathIsInside(relativeName, dir))) continue

      const targetPath = resolve(rootPath, change.fileName)
      try {
        const stat = await options.withGlobalIo(
          'watch:stat-target',
          () => fsp.stat(targetPath),
          { priority: 'normal', storagePath: targetPath },
        )
        if (stat.isDirectory()) {
          const processed = await processDirectory(targetPath)
          if (processed) processedDirectories.push(options.relativeDirectoryPathForRoot(rootPath, targetPath))
        } else if (stat.isFile() && options.fontExtensions.has(extname(targetPath).toLowerCase())) {
          await processFontFile(targetPath)
        }
      } catch (error) {
        const removed = options.removeFontIndexEntriesForPath(rootPath, targetPath, context.cache)
        for (const item of removed) recordDelete(item)
        if (!removed.length && options.fontExtensions.has(extname(targetPath).toLowerCase())) {
          options.appendStartupLog(
            `index event missing file without cache entry: ${targetPath} ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    const changedEntries = Array.from(changedEntryMap.entries())
    const deletedKeys = Array.from(deletedKeySet)
    if (changedEntries.length || deletedKeys.length) {
      if (isRootIndexDbPath(storage.cachePath)) {
        await options.saveRootIndexSqliteChanges(
          storage.cachePath,
          rootPath,
          storage.storage,
          changedEntries,
          deletedKeys,
        )
      } else {
        await options.saveScanCacheFile(
          storage.cachePath,
          {
            version: options.fontScanCacheVersion,
            entries: context.cache.entries || {},
          },
          rootPath,
          storage.storage,
        )
        await options.writeRootCacheManifest(
          storage.cacheDir,
          rootPath,
          storage.storage,
          Object.keys(context.cache.entries || {}).length,
          storage.cachePath,
        )
      }
    }
    if (context.directoryUpdates.length) await options.saveRootDirectorySignatures(context)

    return payload
  }

  return {
    watcherChangeBatchLooksUnchanged,
    applyWatchedFolderChangesToIndex,
    computeWatchedDirectorySignature,
    normalizePendingFolderChanges,
  }
}
