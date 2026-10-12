import type { SharedIoProcessError } from '../path/sharedIoProcessRuntime'
import { throwIfAborted } from '../performance/ioQueue'
import { withSharedIoSignal } from '../path/sharedFileSystemRuntime'
import { validatedWatcherInventoryRows, type WatchedFolderApplyContext } from './watched-folder-index/watchedFolderInventoryRuntime'
import { fontIndexCacheMissReason, type FontIndexFileInput, type FontIndexCacheMissReason } from './manual-refresh/fontIndexEntryBatchRuntime'
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

// Cancellation may replace the error, but never its physical close ownership.
async function awaitFailedSharedIoClose(error: unknown): Promise<void> {
  const failure = error as SharedIoProcessError | undefined
  if (failure?.sharedIo === true) {
    try { await failure.closed } catch { /* Preserve the original failure. */ }
  }
}

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
    } catch (error) {
      await awaitFailedSharedIoClose(error)
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
    // Rename/rescan signals always require a fresh walk; native preflight cannot
    // prove them unchanged, so do not open a DB or start a no-work process.
    if (normalizedChanges.some(change => String(change.eventType || '').toLowerCase() !== 'change')) return false

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
      } catch (error) {
        await awaitFailedSharedIoClose(error)
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
    } catch (error) {
      await awaitFailedSharedIoClose(error)
      return false
    } finally {
      if (db) options.closeSqliteDb(db)
    }
  }

  async function applyWatchedFolderChangesToIndex(changes: PendingFolderChange[], replayUnchanged = false, applyContext: WatchedFolderApplyContext = {}): Promise<FontIndexChangePayload> {
    const apply = async (): Promise<FontIndexChangePayload> => {
      const guard = () => { throwIfAborted(applyContext.signal); applyContext.assertCurrent?.() }
      guard()
      const rootPath = resolve(changes[0]?.folder || '')
      const payload: FontIndexChangePayload = { source: 'watcher', folder: rootPath, at: new Date().toISOString(), upserts: [], deletes: [], errors: [] }
      const normalizedChanges = normalizePendingFolderChanges(changes)
      if (!normalizedChanges.length) return payload
      // Validate all names before loading or changing storage, including names that
      // will be ignored. The receipt belongs to one complete root enumeration.
      const inventoryRows = applyContext.inventory
        ? validatedWatcherInventoryRows(rootPath, applyContext.inventory, options.fontExtensions) : undefined
      if (applyContext.forceVerifyPaths) {
        if (applyContext.forceVerifyPaths.size > 64 || [...applyContext.forceVerifyPaths].some(key => !key || key !== watcherRelativePath(key) || key.includes(':') || key.includes('\0') || key.split('/').some(part => !part || part === '.' || part === '..'))) throw new Error('监听文件变化提示无效或超出预算。')
        if (!options.upsertFontIndexEntries) throw new Error('监听定向内容验证尚未就绪。')
      }
      const storage = await options.ensureRootScanCacheStorage(rootPath, { reuseExisting: true })
      guard()
      const context = options.makeRootScanCacheContext(rootPath, storage)
      const sourceCache = context.cache
      context.cache = { ...sourceCache, entries: { ...sourceCache.entries } }
      context.requireFreshFileStats = true
      context.assertCurrent = guard
      const pendingEntries = new Map<string, FontScanCacheEntry>()
      const committedEntries = new Map<string, FontScanCacheEntry>()
      const deletedKeys = new Set<string>()
      const processedDirectories: string[] = []
      const processedFiles = new Set<string>()
      const upserts = new Map<string, FontItem>()
      const deletes = new Map<string, WatcherDeleteRecord>()
      const misses: Partial<Record<FontIndexCacheMissReason, number>> = {}
      const counts = { examined: 0, added: 0, changed: 0, unchanged: 0, replayed: 0, directories: 0, invalidated: 0, parsed: 0, checkpoints: 0, checkpointRows: 0 }

      const checkpoint = async (final = false): Promise<void> => {
        if (!isRootIndexDbPath(storage.cachePath) || !pendingEntries.size || (!final && pendingEntries.size < 32)) return
        guard()
        const entries = Array.from(pendingEntries)
        // Only upserts may survive a partial pass. RootIndex owns the lock and
        // checks this guard again after acquisition, before submitting a write.
        // Source freshness changes now; foreground cancellation belongs to the
        // later confirmed merged projection commit, never each checkpoint.
        await options.saveRootIndexSqliteChanges(storage.cachePath, rootPath, storage.storage, entries, [], guard, { deferQueryPublication: true })
        for (const [key, entry] of entries) {
          committedEntries.set(key, entry)
          pendingEntries.delete(key)
        }
        counts.checkpoints += 1
        counts.checkpointRows += entries.length
        guard()
        // Merge committed rows only; another writer's independent rows survive.
        for (const [key, entry] of entries) sourceCache.entries[key] = entry
      }
      const recordResult = (key: string, oldEntry: FontScanCacheEntry | undefined, font: FontItem | null) => {
        const entry = context.cache.entries[key]
        processedFiles.add(key)
        counts.examined += 1
        if (options.fontIndexEntryChanged(oldEntry, entry)) {
          if (oldEntry) counts.changed += 1
          else counts.added += 1
          if (entry) pendingEntries.set(key, entry)
          if (font && entry?.status === 'ok') upserts.set(key, font)
          if (oldEntry?.status === 'ok' && oldEntry.font && entry?.status === 'bad') {
            deletes.set(key, options.fontIndexDeleteRecord(rootPath, key, oldEntry))
            counts.invalidated += 1
          }
        } else {
          counts.unchanged += 1
          if (replayUnchanged && font && entry?.status === 'ok') { upserts.set(key, font); counts.replayed += 1 }
          else if (replayUnchanged && entry?.status === 'bad') { deletes.set(key, options.fontIndexDeleteRecord(rootPath, key, oldEntry)); counts.invalidated += 1 }
        }
      }
      const processRows = async (input: Array<{ file: string; freshStat?: CachedFontStatLike }>, deletionCandidates = 0): Promise<void> => {
        const rows = input.filter(row => !processedFiles.has(options.cacheKeyForRootFile(rootPath, row.file))).map(row => ({ ...row, requireSourceStability: true, forceVerify: applyContext.forceVerifyPaths?.has(options.cacheKeyForRootFile(rootPath, row.file)) }))
        const pending = rows.every(row => !!row.freshStat) && options.scriptDetectionVersion !== undefined
          ? rows.filter(row => { const key = options.cacheKeyForRootFile(rootPath, row.file); return row.forceVerify || fontIndexCacheMissReason(context.cache.entries[key], fileCacheSignature(key, row.freshStat!.size, row.freshStat!.mtimeMs), row.freshStat!, options.scriptDetectionVersion!) !== null }).length : undefined
        if (pending !== undefined) applyContext.onProgress?.(pending + deletionCandidates)
        for (let start = 0; start < rows.length; start += 32) {
          guard()
          const chunk = rows.slice(start, start + 32)
          if (options.upsertFontIndexEntries && chunk.every(row => !!row.freshStat)) {
            const oldEntries = new Map(chunk.map(row => { const key = options.cacheKeyForRootFile(rootPath, row.file); return [key, context.cache.entries[key]] as const }))
            const result = await options.upsertFontIndexEntries(rootPath, chunk as FontIndexFileInput[], context.cache, applyContext.signal, guard)
            guard()
            for (const [reason, count] of Object.entries(result.misses)) misses[reason as FontIndexCacheMissReason] = (misses[reason as FontIndexCacheMissReason] || 0) + Number(count)
            counts.parsed += result.parsed
            for (const item of result.results) {
              if (item.error) { payload.errors!.push({ path: item.file, message: item.error }); processedFiles.add(item.key); continue }
              recordResult(item.key, oldEntries.get(item.key), item.font)
            }
          } else {
            for (const row of chunk) {
              guard()
              const key = options.cacheKeyForRootFile(rootPath, row.file)
              if (processedFiles.has(key)) continue
              const oldEntry = context.cache.entries[key]
              try {
                const font = await options.upsertFontIndexEntry(rootPath, row.file, context.cache, row.freshStat)
                guard()
                recordResult(key, oldEntry, font)
              } catch (error) { await awaitFailedSharedIoClose(error); guard(); payload.errors!.push({ path: row.file, message: error instanceof Error ? error.message : String(error) }) }
            }
          }
          await checkpoint()
        }
      }
      const queueMissingRows = (relativeDir: string, seen: Set<string>) => {
        for (const [key, entry] of Object.entries(context.cache.entries)) {
          if (!options.cacheKeyInsideDirectory(key, relativeDir) || seen.has(key)) continue
          deletedKeys.add(key)
          deletes.set(key, options.fontIndexDeleteRecord(rootPath, key, entry))
        }
      }
      try {
        if (inventoryRows) {
          counts.directories = 1
          const seen = new Set(inventoryRows.map(row => options.cacheKeyForRootFile(rootPath, row.file)))
          const missing = Object.keys(context.cache.entries).filter(key => !seen.has(key)).length
          await processRows(inventoryRows, missing)
          queueMissingRows('', seen)
        } else for (const change of normalizedChanges) {
          guard()
          const relativeName = watcherRelativePath(change.fileName)
          if (!relativeName || processedDirectories.some(dir => watcherPathIsInside(relativeName, dir))) continue
          const targetPath = resolve(rootPath, change.fileName)
          let confirmedMissing = false
          try {
            let stat: fs.Stats
            try {
              stat = await options.withGlobalIo('watch:stat-target', () => fsp.stat(targetPath), { priority: 'normal', storagePath: targetPath })
              guard()
            } catch (error) {
              await awaitFailedSharedIoClose(error)
              guard()
              const code = (error as NodeJS.ErrnoException).code
              if ((code === 'ENOENT' || code === 'ENOTDIR') && targetPath !== rootPath) {
                const rootStat = await options.withGlobalIo('watch:verify-root', () => fsp.stat(rootPath), { priority: 'normal', storagePath: rootPath })
                guard()
                confirmedMissing = rootStat.isDirectory()
              }
              throw error
            }
            if (stat.isDirectory()) {
              counts.directories += 1
              const errorsBefore = payload.errors!.length
              const rows = await options.listFontFilesWithDirectoryCache(context, payload.errors!, undefined, applyContext.signal, targetPath)
              guard()
              for (const row of rows) if (row.error) payload.errors!.push({ path: row.file, message: row.error })
              if (payload.errors!.length !== errorsBefore) continue
              await processRows(rows.map(row => ({ file: row.file, freshStat: row.freshStat ? row.stat || undefined : undefined })))
              const relativeDir = options.relativeDirectoryPathForRoot(rootPath, targetPath)
              queueMissingRows(relativeDir, new Set(rows.map(row => options.cacheKeyForRootFile(rootPath, row.file))))
              processedDirectories.push(relativeDir)
            } else if (stat.isFile() && options.fontExtensions.has(extname(targetPath).toLowerCase())) {
              // Reuse the target stat already obtained when the production batch
              // port is present; compatibility callers retain their old contract.
              await processRows([{ file: targetPath, freshStat: options.upsertFontIndexEntries ? stat : undefined }])
            }
          } catch (error) {
            await awaitFailedSharedIoClose(error)
            guard()
            if (!confirmedMissing) { payload.errors!.push({ path: targetPath, message: error instanceof Error ? error.message : String(error) }); continue }
            const removed = options.removeFontIndexEntriesForPath(rootPath, targetPath, { ...context.cache, entries: { ...context.cache.entries } })
            for (const item of removed) { deletedKeys.add(item.relativePath); deletes.set(item.relativePath, item) }
            if (!removed.length && options.fontExtensions.has(extname(targetPath).toLowerCase())) {
              const key = options.cacheKeyForRootFile(rootPath, targetPath)
              deletes.set(key, { path: targetPath, relativePath: key })
            }
          }
        }
        guard()
        if (payload.errors!.length) { deletedKeys.clear(); deletes.clear() }
        for (const key of deletedKeys) { pendingEntries.delete(key); upserts.delete(key) }
        if (isRootIndexDbPath(storage.cachePath)) {
          // Keep the final complete deletion proof in one final transaction.
          const entries = Array.from(pendingEntries)
          if (entries.length || deletedKeys.size) {
            await options.saveRootIndexSqliteChanges(storage.cachePath, rootPath, storage.storage, entries, Array.from(deletedKeys), guard, { deferQueryPublication: true })
            for (const [key, entry] of entries) committedEntries.set(key, entry)
            guard()
          }
        } else if (pendingEntries.size || deletedKeys.size) {
          for (const key of deletedKeys) delete context.cache.entries[key]
          await options.saveScanCacheFile(storage.cachePath, { version: options.fontScanCacheVersion, entries: context.cache.entries }, rootPath, storage.storage)
          guard()
          await options.writeRootCacheManifest(storage.cacheDir, rootPath, storage.storage, Object.keys(context.cache.entries).length, storage.cachePath)
          for (const [key, entry] of pendingEntries) committedEntries.set(key, entry)
          guard()
        }
        if (context.directoryUpdates.length && !payload.errors!.length) {
          guard()
          await options.saveRootDirectorySignatures(context)
          guard()
        }
        for (const [key, entry] of committedEntries) sourceCache.entries[key] = entry
        for (const key of deletedKeys) delete sourceCache.entries[key]
        payload.upserts = Array.from(upserts.values())
        payload.deletes = Array.from(deletes.values())
        options.appendStartupLog(`font index watcher diff: ${JSON.stringify({ recovery: replayUnchanged, events: changes.length, targets: normalizedChanges.length,
          deduplicated: changes.length - normalizedChanges.length, expansion: inventoryRows ? 'metadata-inventory' : counts.directories ? 'directory-enumeration' : 'targeted-files',
          ...counts, cacheMissReasons: misses, deleted: deletedKeys.size, upserts: payload.upserts.length, errors: payload.errors!.length })}`)
        return payload
      } catch (error) {
        // Persisted checkpoints are read back on retry; never replay old writes.
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { watcherRecoveryDisposition: 'defer' as const,
          watcherCommittedCheckpointRows: committedEntries.size,
          watcherRecoveryChanges: Array.from(deletes.values(), item => ({ folder: rootPath, fileName: item.relativePath, eventType: 'rescan', receivedAt: Date.now() })) })
      }
    }
    return applyContext.signal ? withSharedIoSignal(applyContext.signal, apply) : apply()
  }

  return {
    watcherChangeBatchLooksUnchanged,
    applyWatchedFolderChangesToIndex,
    computeWatchedDirectorySignature,
    normalizePendingFolderChanges,
  }
}
