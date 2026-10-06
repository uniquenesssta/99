import type fs from 'node:fs'
import type { CachedFontStatLike } from '../fonts/fontRuntime'
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime'
import { extname,resolve } from 'node:path'
import type { FontIndexChangePayload,FontItem } from '../../shared/types'
import { fileCacheSignature,isIgnoredInternalDirectoryName,isRootIndexDbPath } from '../cache/cachePaths'
import type { FontScanCacheEntry } from '../indexing/rootIndexRuntime'
import type { PendingFolderChange } from './folderWatcherRuntime'
import type { RootDirectorySignature, WatchedFolderIndexRuntime, WatchedFolderIndexRuntimeOptions, WatcherDeleteRecord } from './watched-folder-index/watchedFolderIndexTypes'
export type { RootDirectorySignature, RootScanCacheContext, RootScanCacheStorage, WatchedFolderIndexRuntime } from './watched-folder-index/watchedFolderIndexTypes'
import { watcherPathDepth, watcherPathIsInside, watcherRelativePath } from './watched-folder-index/watchedFolderPathRuntime'

export function createWatchedFolderIndexRuntime(options: WatchedFolderIndexRuntimeOptions): WatchedFolderIndexRuntime {
  function normalizePendingFolderChanges(changes: PendingFolderChange[]): PendingFolderChange[] {
    const byPath = new Map<string, PendingFolderChange>()
    for (const change of changes || []) {
      const fileName = String(change.fileName || '').replace(/^[/\\]+/, '')
      if (!fileName || options.isIgnoredWatcherPath(fileName)) continue
      const key = watcherRelativePath(fileName)
      const previous = byPath.get(key)
      // A later low-information change must not erase a rename/rescan signal.
      if (previous && previous.eventType !== 'change' && change.eventType === 'change') continue
      byPath.set(key, { ...change, fileName })
    }
    return Array.from(byPath.values()).sort((a, b) => watcherPathDepth(a.fileName) - watcherPathDepth(b.fileName))
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
        scriptDetectionVersion: options.scriptDetectionVersion,
        changes: normalizedChanges.map((change) => ({
          eventType: change.eventType,
          fileName: watcherRelativePath(change.fileName),
        })),
      })
      if (rustResult) return rustResult.unchanged
    }

    const fontTargets: Array<{ relativePath: string; cacheKey: string }> = []

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

      // A child overwrite/rename need not change the parent mtime or counts.
      // Directory signals require current enumeration and per-file comparison.
      if (stat.isDirectory()) return false

      return false
    }

    if (!fontTargets.length) return true

    let db: any | null = null
    try {
      db = await options.openRootIndexDb(dbPath, rootPath, 'root', false)
      const entryStmt = db.prepare(
        'SELECT cache_key, status, font_json FROM entries WHERE relative_path = ? AND is_deleted = 0',
      )
      for (const target of fontTargets) {
        const row = entryStmt.get(target.relativePath) as { cache_key?: string; status?: string; font_json?: string } | undefined
        if (!row || row.cache_key !== target.cacheKey) return false
        if (row.status !== 'ok' && row.status !== 'bad') return false
        if (row.status === 'ok' && options.scriptDetectionVersion !== undefined) {
          const font = JSON.parse(row.font_json || 'null') as FontItem | null
          if (!font || !Array.isArray(font.scripts) || !font.scripts.length || font.scriptVersion !== options.scriptDetectionVersion) return false
        }
      }


      return true
    } catch {
      return false
    } finally {
      if (db) options.closeSqliteDb(db)
    }
  }

  async function applyWatchedFolderChangesToIndex(changes: PendingFolderChange[], replayUnchanged = false): Promise<FontIndexChangePayload> {
    const first = changes[0]
    const rootPath = resolve(first?.folder || '')
    const payload: FontIndexChangePayload = {
      source: 'watcher',
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
    const sourceCache = context.cache
    context.cache = { ...sourceCache, entries: { ...sourceCache.entries } }
    context.requireFreshFileStats = true
    const changedEntryMap = new Map<string, FontScanCacheEntry>()
    const deletedKeySet = new Set<string>()
    const processedDirectories: string[] = []
    const processedFiles = new Set<string>()
    const upserts = new Map<string, FontItem>()
    const deletes = new Map<string, WatcherDeleteRecord>()
    const counts = { examined: 0, added: 0, changed: 0, unchanged: 0, replayed: 0, directories: 0, invalidated: 0 }
    const eventSummary = normalizedChanges.slice(0, 8).map(change => ({
      path: change.fileName, type: change.eventType,
      trigger: change.triggerEventType || change.eventType, origin: change.origin || 'unspecified',
    }))

    const recordChangedEntry = (
      key: string,
      entry: FontScanCacheEntry | undefined,
      font: FontItem | null,
    ): void => {
      if (!entry) return
      deletedKeySet.delete(key)
      changedEntryMap.set(key, entry)
      if (font && entry.status === 'ok') upserts.set(key, font)
    }

    const recordDelete = (item: WatcherDeleteRecord): void => {
      const key = item.relativePath
      changedEntryMap.delete(key)
      deletedKeySet.add(key)
      deletes.set(key, item)
      upserts.delete(key)
      delete context.cache.entries[key]
    }

    async function processFontFile(filePath: string, freshStat?: CachedFontStatLike): Promise<void> {
      const key = options.cacheKeyForRootFile(rootPath, filePath)
      if (processedFiles.has(key)) return
      counts.examined += 1
      const oldEntry = context.cache.entries[key]
      const font = await options.upsertFontIndexEntry(rootPath, filePath, context.cache, freshStat)
      const newEntry = context.cache.entries[key]
      processedFiles.add(key)
      if (options.fontIndexEntryChanged(oldEntry, newEntry)) {
        if (oldEntry) counts.changed += 1
        else counts.added += 1
        recordChangedEntry(key, newEntry, font)
        // Keep the bad entry as evidence, but withdraw an obsolete valid merged row.
        if (oldEntry?.status === 'ok' && oldEntry.font && newEntry?.status === 'bad') {
          deletes.set(key, options.fontIndexDeleteRecord(rootPath, key, oldEntry))
          counts.invalidated += 1
        }
      } else {
        counts.unchanged += 1
        // Recovery may need to redeliver rows committed before a failed notification.
        if (replayUnchanged && font && newEntry?.status === 'ok') {
          upserts.set(key, font)
          counts.replayed += 1
        } else if (replayUnchanged && newEntry?.status === 'bad') {
          deletes.set(key, options.fontIndexDeleteRecord(rootPath, key, oldEntry))
          counts.invalidated += 1
        }
      }
    }

    async function processDirectory(targetPath: string): Promise<boolean> {
      const relativeDir = options.relativeDirectoryPathForRoot(rootPath, targetPath)
      // The fresh directory-cache walk below owns enumeration and completeness.
      // A separate stat/readdir signature probe duplicates that same work.
      counts.directories += 1

      const errors = payload.errors || []
      const errorCount = errors.length
      const rows = await options.listFontFilesWithDirectoryCache(
        context,
        errors,
        undefined,
        undefined,
        targetPath,
      )
      for (const row of rows) {
        if (row.error) errors.push({ path: row.file, message: row.error })
      }
      if (errors.length > errorCount) return false
      const seenKeysInDirectory = new Set<string>()

      for (const row of rows) {
        const key = options.cacheKeyForRootFile(rootPath, row.file)
        seenKeysInDirectory.add(key)
        await processFontFile(row.file, row.freshStat ? row.stat ?? undefined : undefined)
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
      let confirmedMissing = false
      try {
        let stat: fs.Stats
        try {
          stat = await options.withGlobalIo(
            'watch:stat-target',
            () => fsp.stat(targetPath),
            { priority: 'normal', storagePath: targetPath },
          )
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if ((code === 'ENOENT' || code === 'ENOTDIR') && targetPath !== rootPath) {
            const rootStat = await options.withGlobalIo('watch:verify-root', () => fsp.stat(rootPath), { priority: 'normal', storagePath: rootPath })
            confirmedMissing = rootStat.isDirectory()
          }
          throw error
        }
        if (stat.isDirectory()) {
          const processed = await processDirectory(targetPath)
          if (processed) processedDirectories.push(options.relativeDirectoryPathForRoot(rootPath, targetPath))
        } else if (stat.isFile() && options.fontExtensions.has(extname(targetPath).toLowerCase())) {
          await processFontFile(targetPath)
        }
      } catch (error) {
        if (!confirmedMissing) {
          payload.errors?.push({ path: targetPath, message: error instanceof Error ? error.message : String(error) })
          continue
        }
        const removed = options.removeFontIndexEntriesForPath(rootPath, targetPath, context.cache)
        for (const item of removed) recordDelete(item)
        if (!removed.length && options.fontExtensions.has(extname(targetPath).toLowerCase())) {
          const key = options.cacheKeyForRootFile(rootPath, targetPath)
          deletes.set(key, { path: targetPath, relativePath: key })
          options.appendStartupLog(
            `index event missing file without cache entry: ${targetPath} ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }

    payload.upserts = Array.from(upserts.values())
    payload.deletes = Array.from(deletes.values())
    options.appendStartupLog(`font index watcher diff: ${JSON.stringify({
      root: rootPath, recovery: replayUnchanged, events: changes.length, targets: normalizedChanges.length,
      deduplicated: changes.length - normalizedChanges.length,
      expansion: counts.directories ? (normalizedChanges.some(change => change.fileName === '.') ? 'root-enumeration' : 'directory-enumeration') : 'targeted-files',
      samples: eventSummary, omittedEvents: Math.max(0, normalizedChanges.length - eventSummary.length),
      ...counts, deleted: deletedKeySet.size, upserts: payload.upserts.length, errors: payload.errors?.length || 0,
    })}`)
    try {
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
      if (context.directoryUpdates.length && !payload.errors?.length) await options.saveRootDirectorySignatures(context)

    } catch (error) {
      // A writer may commit before reporting a later failure. Retain paths, not old writes.
      throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), {
        watcherRecoveryDisposition: 'defer' as const,
        watcherRecoveryChanges: payload.deletes.map((item) => ({ folder: rootPath, fileName: item.relativePath, eventType: 'rescan', receivedAt: Date.now() })),
      })
    }
    sourceCache.entries = context.cache.entries
    return payload
  }

  return {
    watcherChangeBatchLooksUnchanged,
    applyWatchedFolderChangesToIndex,
    computeWatchedDirectorySignature,
    normalizePendingFolderChanges,
  }
}
