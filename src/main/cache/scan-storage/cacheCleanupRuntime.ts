import { promises as fsp } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import type { CacheStats } from '../../../shared/types'
import { sqliteSidecarPaths } from '../cachePaths'
import {
LEGACY_ROOT_SCAN_CACHE_LOCK_FILE_NAME,
ROOT_CACHE_LOCK_DIR_NAME,
ROOT_CACHE_MANIFEST_FILE_NAME,
ROOT_INDEX_LOCK_FILE_NAME,
ROOT_INDEX_BUILD_LOCK_FILE_NAME,
ROOT_SCAN_CACHE_LOCK_FILE_NAME
} from '../constants'
import type { ScanCacheStatsReader,ScanCacheStorageRuntimeOptions } from './scanCacheStorageTypes'

export function createCacheCleanupRuntime(options: ScanCacheStorageRuntimeOptions, deps: { getCacheStats: ScanCacheStatsReader }) {
  async function clearScanCache(): Promise<CacheStats> {
    const files = new Set<string>([options.legacyScanCachePath()])
    const dirs = new Set<string>()

    try {
      const library = await options.loadLibraryShell()
      for (const rawFolder of library.folders || []) {
        if (!rawFolder) continue
        const folder = resolve(rawFolder)
        for (const dbPath of await options.listRootIndexDatabaseFiles(options.rootCacheDir(folder), options.rootIndexDbPath(folder))) {
          for (const file of sqliteSidecarPaths(dbPath)) files.add(file)
        }
        files.add(options.rootScanCachePath(folder))
        files.add(options.rootLegacyScanCachePath(folder))
        files.add(join(options.rootCacheDir(folder), ROOT_CACHE_MANIFEST_FILE_NAME))
        files.add(options.rootIndexLockPath(folder))
        files.add(join(options.rootCacheDir(folder), ROOT_CACHE_LOCK_DIR_NAME, ROOT_INDEX_BUILD_LOCK_FILE_NAME))
        files.add(join(options.rootCacheDir(folder), ROOT_SCAN_CACHE_LOCK_FILE_NAME))
        files.add(join(options.rootIndexDbDir(folder), ROOT_SCAN_CACHE_LOCK_FILE_NAME))
        files.add(join(options.rootCacheDir(folder), LEGACY_ROOT_SCAN_CACHE_LOCK_FILE_NAME))
        for (const dbPath of await options.listRootIndexDatabaseFiles(options.fallbackCacheRootDir(folder), options.fallbackIndexDbPath(folder))) {
          for (const file of sqliteSidecarPaths(dbPath)) files.add(file)
        }
        files.add(options.fallbackScanCachePath(folder))
        files.add(options.fallbackLegacyScanCachePath(folder))
        files.add(join(options.fallbackCacheRootDir(folder), ROOT_CACHE_MANIFEST_FILE_NAME))
        files.add(join(options.fallbackCacheRootDir(folder), ROOT_CACHE_LOCK_DIR_NAME, ROOT_INDEX_LOCK_FILE_NAME))
        files.add(join(options.fallbackCacheRootDir(folder), ROOT_CACHE_LOCK_DIR_NAME, ROOT_INDEX_BUILD_LOCK_FILE_NAME))
        files.add(join(options.fallbackCacheRootDir(folder), ROOT_SCAN_CACHE_LOCK_FILE_NAME))
        files.add(join(dirname(options.fallbackIndexDbPath(folder)), ROOT_SCAN_CACHE_LOCK_FILE_NAME))
        files.add(join(options.fallbackCacheRootDir(folder), LEGACY_ROOT_SCAN_CACHE_LOCK_FILE_NAME))
      }
    } catch {
      // ignore
    }

    for (const filePath of files) {
      try {
        await fsp.rm(filePath, { force: true })
      } catch {
        // ignore
      }
    }

    for (const dirPath of dirs) {
      try {
        await fsp.rm(dirPath, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }

    return deps.getCacheStats()
  }

  async function clearPreviewCache(): Promise<CacheStats> {
    const dirs = new Set<string>([options.localPreviewImageDir()])
    try {
      const library = await options.loadLibraryShell()
      for (const rawFolder of library.folders || []) {
        if (!rawFolder) continue
        const folder = resolve(rawFolder)
        dirs.add(options.rootPreviewCacheDir(folder))
        dirs.add(options.legacyRootPreviewCacheDir(folder))
        dirs.add(options.fallbackPreviewCacheDir(folder))
      }
    } catch {
      // ignore
    }

    for (const dirPath of dirs) {
      try {
        await fsp.rm(dirPath, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }

    try {
      options.clearLocalPreviewDbHandle()
      for (const filePath of sqliteSidecarPaths(options.previewSqlitePath())) {
        try {
          await fsp.rm(filePath, { force: true })
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }

    return deps.getCacheStats()
  }

  return {
    clearScanCache,
    clearPreviewCache
  }
}
