import type { FontIndexChangePayload, ScanResult } from '../../../shared/types'
import type { CachedFontStatLike } from '../../fonts/fontRuntime'
import type { FontScanCacheEntry, FontScanCacheFile } from '../../indexing/rootIndexRuntime'
import type { GlobalIoOptions } from '../../performance/ioScheduler'
import type { PendingFolderChange } from '../folderWatcherRuntime'
import type { RustWatcherPreflightInput, RustWatcherPreflightResult } from '../../rust-core/rustCoreWorkerRuntime'

export interface RootDirectorySignature {
  modifiedAt: number
  fileCount: number
  dirCount: number
}

export interface RootScanCacheContext {
  rootPath: string
  cachePath: string
  cacheDir: string
  storage: 'root' | 'fallback'
  cache: FontScanCacheFile
  nextEntries: Record<string, FontScanCacheEntry>
  seenKeys: Set<string>
  directoryUpdates: Array<{
    relativePath: string
    modifiedAt: number
    fileCount: number
    dirCount: number
  }>
  directorySkipped: number
}

export interface RootScanCacheStorage {
  cachePath: string
  cacheDir: string
  storage: 'root' | 'fallback'
  cache: FontScanCacheFile
}

export interface WatcherDeleteRecord {
  path: string
  relativePath: string
  id?: string
}

export interface WatchedFolderIndexRuntimeOptions {
  appendStartupLog: (message: string) => void
  fontExtensions: Set<string>
  isIgnoredWatcherPath: (fileName?: string) => boolean
  cacheKeyForRootFile: (rootPath: string, filePath: string) => string
  rootIndexDbPath: (rootPath: string) => string
  rootCacheDir: (rootPath: string) => string
  exists: (pathValue: string) => Promise<boolean>
  resolveActiveRootIndexDbPath: (cacheDir: string, defaultDbPath: string) => Promise<string>
  openRootIndexDb: (dbPath: string, rootPath: string, storage: 'root' | 'fallback', writable: boolean) => Promise<any>
  closeSqliteDb: (db: any) => void
  withGlobalIo: <T>(label: string, task: () => Promise<T>, options?: GlobalIoOptions) => Promise<T>
  makeRootScanCacheContext: (rootPath: string, storage: RootScanCacheStorage) => RootScanCacheContext
  ensureRootScanCacheStorage: (rootPath: string) => Promise<RootScanCacheStorage>
  readRootDirectorySignatures: (context: RootScanCacheContext) => Promise<Map<string, RootDirectorySignature>>
  saveRootDirectorySignatures: (context: RootScanCacheContext) => Promise<void>
  relativeDirectoryPathForRoot: (rootPath: string, dirPath: string) => string
  listFontFilesWithDirectoryCache: (
    context: RootScanCacheContext,
    errors: ScanResult['errors'],
    progress?: (payload: { files: number; foldersScanned: number; skippedDirs: number }) => void,
    signal?: AbortSignal,
    startDir?: string,
  ) => Promise<Array<{ file: string; rootPath: string; stat: CachedFontStatLike | null; error: string }>>
  upsertFontIndexEntry: (rootPath: string, filePath: string, cache: FontScanCacheFile) => Promise<import('../../../shared/types').FontItem | null>
  fontIndexEntryChanged: (oldEntry: FontScanCacheEntry | undefined, newEntry: FontScanCacheEntry | undefined) => boolean
  cacheKeyInsideDirectory: (cacheKey: string, relativeDir: string) => boolean
  fontIndexDeleteRecord: (rootPath: string, cacheKey: string, entry?: FontScanCacheEntry) => WatcherDeleteRecord
  removeFontIndexEntriesForPath: (rootPath: string, targetPath: string, cache: FontScanCacheFile) => WatcherDeleteRecord[]
  saveRootIndexSqliteChanges: (
    dbPath: string,
    rootPath: string,
    storage: 'root' | 'fallback',
    changedEntries: Array<[string, FontScanCacheEntry]>,
    deletedKeys: string[],
  ) => Promise<void>
  saveScanCacheFile: (
    filePath: string,
    cache: FontScanCacheFile,
    rootPath?: string,
    storage?: 'root' | 'fallback',
  ) => Promise<void>
  writeRootCacheManifest: (
    cacheDir: string,
    rootPath: string,
    storage: 'root' | 'fallback',
    count: number,
    cachePath: string,
  ) => Promise<void>
  fontScanCacheVersion: number
  runRustWatcherPreflight?: (input: RustWatcherPreflightInput) => Promise<RustWatcherPreflightResult | null>
}

export interface WatchedFolderIndexRuntime {
  watcherChangeBatchLooksUnchanged: (rootPath: string, changes: PendingFolderChange[]) => Promise<boolean>
  applyWatchedFolderChangesToIndex: (changes: PendingFolderChange[]) => Promise<FontIndexChangePayload>
  computeWatchedDirectorySignature: (dirPath: string) => Promise<RootDirectorySignature | null>
  normalizePendingFolderChanges: (changes: PendingFolderChange[]) => PendingFolderChange[]
}
