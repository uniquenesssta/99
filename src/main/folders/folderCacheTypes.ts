import type { FontItem } from '../../shared/types'
import type { CachedFontStatLike } from '../fonts/fontRuntime'
import type { FontScanCacheEntry,FontScanCacheFile } from '../indexing/rootIndexRuntime'

export interface FolderCacheSource {
  cache: FontScanCacheFile
  cachePath: string
  storage: 'root' | 'fallback'
}

export interface FolderCacheRuntimeDeps {
  fontScanCacheVersion: number
  sharedFontMemoryCacheTtlMs: number
  exists: (filePath: string) => Promise<boolean>
  rootCacheDir: (rootPath: string) => string
  rootIndexDbPath: (rootPath: string) => string
  fallbackIndexDbPath: (rootPath: string) => string
  fallbackCacheRootDir: (rootPath: string) => string
  resolveActiveRootIndexDbPath: (rootDir: string, defaultDbPath: string) => Promise<string>
  readRootIndexSqliteFile: (
    rootIndexPath: string,
    rootPath: string,
    storage: 'root' | 'fallback',
  ) => Promise<FontScanCacheFile>
  saveRootIndexSqliteFile: (
    rootIndexPath: string,
    rootPath: string,
    storage: 'root' | 'fallback',
    cache: FontScanCacheFile,
  ) => Promise<void>
  saveRootIndexSqliteChanges: (
    rootIndexPath: string,
    rootPath: string,
    storage: 'root' | 'fallback',
    changedEntries: Array<[string, FontScanCacheEntry]>,
    removedKeys: string[],
  ) => Promise<void>
  applySharedMetadataOverlay: (
    rootPath: string,
    cache: FontScanCacheFile,
  ) => Promise<FontScanCacheFile>
  saveScanCacheFile: (
    cachePath: string,
    cache: FontScanCacheFile,
    rootPath: string,
    storage: 'root' | 'fallback',
  ) => Promise<void>
  cacheEntryRuntimePath: (rootPath: string, entryPath: string) => string
  cachedFontForRuntime: (
    font: FontItem,
    runtimePath: string,
    stat: CachedFontStatLike,
    cacheKey?: string,
  ) => FontItem
  sha1: (value: string) => string
  recoveryMessage: (error: unknown) => string
  quarantineSqliteFiles: (
    filePath: string,
    reason: string,
    message: string,
    quarantineDir?: string,
  ) => Promise<unknown>
  appendStartupLog: (message: string) => void
  clearExternalFontQueryCaches: () => void
}

export interface SharedFontsMemoryCache {
  foldersKey: string
  loadedAt: number
  fonts: FontItem[]
}
