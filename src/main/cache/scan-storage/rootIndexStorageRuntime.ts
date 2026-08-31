import { promises as fsp } from 'node:fs'
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
        if (storage === 'fallback') {
          await options.quarantineSqliteFiles(
            cacheDbPath,
            `fallback-root-index-${options.sha1(rootPath).slice(0, 10)}`,
            options.recoveryMessage(error),
            options.fallbackCacheRootDir(rootPath)
          ).catch((quarantineError) => {
            options.appendStartupLog(`fallback root index quarantine skipped: ${options.recoveryMessage(quarantineError)}`)
          })
          return { version: options.fontScanCacheVersion, entries: {} }
        }
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

  async function ensureRootScanCacheStorage(rootPath: string): Promise<{
    cachePath: string
    cacheDir: string
    storage: RootIndexStorage
    cache: FontScanCacheFile
  }> {
    const resolvedRoot = resolve(rootPath)
    const rootDir = options.rootCacheDir(resolvedRoot)
    const rootDefaultDbPath = options.rootIndexDbPath(resolvedRoot)

    await fsp.mkdir(options.rootIndexDbDir(resolvedRoot), { recursive: true })
    await fsp.mkdir(options.rootCacheLockDir(resolvedRoot), { recursive: true })
    await deps.hideDirectoryOnWindows(rootDir)
    await options.ensureRootArchitectureDatabases(resolvedRoot)
    const activeRootDbPath = await options.resolveActiveRootIndexDbPath(rootDir, rootDefaultDbPath)
    await options.writeRootCacheManifest(rootDir, resolvedRoot, 'root', 0, activeRootDbPath)
    return {
      cachePath: activeRootDbPath,
      cacheDir: rootDir,
      storage: 'root',
      cache: await options.readRootIndexSqliteFile(activeRootDbPath, resolvedRoot, 'root')
    }
  }

  return {
    loadOrMigrateRootIndex,
    loadLegacyScanCache,
    ensureRootScanCacheStorage
  }
}
