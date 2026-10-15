import { readRootIndexRebuildRequest } from '../../indexing/root-index/rootIndexRebuildRequestRuntime'
import { isRecoverableDerivedSqliteError } from '../../db/sqliteRecoveryPolicy'
import { sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { resolve } from 'node:path'
import type { FontScanCacheFile } from '../../indexing/rootIndexRuntime'
import type { RootIndexStorage,ScanCacheStorageRuntimeOptions } from './scanCacheStorageTypes'

export function createRootIndexStorageRuntime(
  options: ScanCacheStorageRuntimeOptions,
  deps: {
    readScanCacheFile: (filePath: string) => Promise<FontScanCacheFile>
    hideDirectoryOnWindows: (dir: string) => Promise<void>
  }
) {
  async function loadOrMigrateRootIndex(
    cacheDbPath: string,
    rootPath: string,
    storage: RootIndexStorage,
    legacyJsonPaths: string[]
  ): Promise<FontScanCacheFile> {
    if (await options.exists(cacheDbPath)) {
      try {
        return await options.readRootIndexSqliteFile(cacheDbPath, rootPath, storage)
      } catch (error) {
        options.appendStartupLog(
          `root index read failed: storage=${storage}, path=${cacheDbPath}, ${options.recoveryMessage(error)}`
        )
        throw error
      }
    }

    for (const jsonPath of legacyJsonPaths) {
      if (!(await options.exists(jsonPath))) continue
      const cache = await deps.readScanCacheFile(jsonPath)
      await options.saveRootIndexSqliteFile(cacheDbPath, rootPath, storage, cache)
      options.appendStartupLog(`legacy font-index json migrated to SQLite: ${jsonPath} -> ${cacheDbPath}`)
      return cache
    }

    return { version: options.fontScanCacheVersion, entries: {} }
  }

  async function loadLegacyScanCache(): Promise<FontScanCacheFile> {
    return deps.readScanCacheFile(options.legacyScanCachePath())
  }

  async function ensureRootScanCacheStorage(rootPath: string, request: { reuseExisting?: boolean; rebuildRequested?: boolean } = {}): Promise<{
    cachePath: string
    cacheDir: string
    storage: RootIndexStorage
    cache: FontScanCacheFile
  }> {
    const resolvedRoot = resolve(rootPath)
    const rootDir = options.rootCacheDir(resolvedRoot)
    const rootDefaultDbPath = options.rootIndexDbPath(resolvedRoot)

    const rebuildRequestId = request.rebuildRequested ? await readRootIndexRebuildRequest(rootDir) : undefined

    // A watcher starts with fresh read evidence from the current active index.
    // Existing compatible storage needs no manifest publication or unrelated
    // cache initialization; each eventual writer owns its own schema/lock setup.
    if (request.reuseExisting && !rebuildRequestId) {
      const activePath = await options.resolveActiveRootIndexDbPath(rootDir, rootDefaultDbPath)
      if (await options.exists(activePath)) {
        try {
          const cache = await options.readRootIndexSqliteFile(activePath, resolvedRoot, 'root')
          // Only a completed SQLite snapshot includes directorySignatures. The
          // reader's missing-file sentinel must take the normal recovery path
          // when the index disappears between the outer and inner probes.
          if (!cache.rebuildRequired && Array.isArray(cache.directorySignatures)) {
            return { cachePath: activePath, cacheDir: rootDir, storage: 'root', cache }
          }
        } catch (error) {
          if (!isRecoverableDerivedSqliteError(error)) throw error
        }
      }
    }

    await fsp.mkdir(options.rootIndexDbDir(resolvedRoot), { recursive: true })
    await fsp.mkdir(options.rootCacheLockDir(resolvedRoot), { recursive: true })
    await deps.hideDirectoryOnWindows(rootDir)
    await options.ensureRootArchitectureDatabases(resolvedRoot)
    const activeRootDbPath = await options.resolveActiveRootIndexDbPath(rootDir, rootDefaultDbPath)
    if (rebuildRequestId) return {
      cachePath: activeRootDbPath, cacheDir: rootDir, storage: 'root',
      cache: { version: options.fontScanCacheVersion, entries: {}, rebuildRequired: true, rebuildRequestId },
    }
    let cache: FontScanCacheFile
    try {
      cache = await options.readRootIndexSqliteFile(activeRootDbPath, resolvedRoot, 'root')
      if (!await options.exists(activeRootDbPath)) cache = { ...cache, rebuildRequired: true }
      if (cache.rebuildRequired) cache = { version: options.fontScanCacheVersion, entries: {}, rebuildRequired: true }
    } catch (error) {
      if (!isRecoverableDerivedSqliteError(error)) throw error
      options.appendStartupLog(`root index rebuild required; original retained: ${activeRootDbPath}, ${options.recoveryMessage(error)}`)
      cache = { version: options.fontScanCacheVersion, entries: {}, rebuildRequired: true }
    }
    if (!cache.rebuildRequired && await options.exists(activeRootDbPath).catch(() => false)) {
      await options.writeRootCacheManifest(rootDir, resolvedRoot, 'root', Object.keys(cache.entries || {}).length, activeRootDbPath).catch((error) => {
        options.appendStartupLog(`root index manifest recovery pending: root=${resolvedRoot}, db=${activeRootDbPath}, ${options.recoveryMessage(error)}`)
      })
    }
    return { cachePath: activeRootDbPath, cacheDir: rootDir, storage: 'root', cache }
  }

  return {
    loadOrMigrateRootIndex,
    loadLegacyScanCache,
    ensureRootScanCacheStorage
  }
}
