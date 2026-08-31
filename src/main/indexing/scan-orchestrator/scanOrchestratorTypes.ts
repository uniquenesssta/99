import type { FontIndexChangePayload,FontIndexProgressPayload,FontItem,ScanResult } from '../../../shared/types'
import type { CachedFontStatLike } from '../../fonts/fontRuntime'
import type { GlobalIoOptions,IoQueueSnapshot } from '../../performance/ioScheduler'
import type { RootDirectorySignature,RootScanCacheContext } from '../../watcher/watchedFolderIndexRuntime'
import type { FontParseJob,FontParseWorkerResult,RustFontFamilyHint,RustFontNameHint,RustFontScriptHint,RustFontStyleHint } from '../fontScanWorkers'
import type { FontScanCacheEntry,FontScanCacheFile } from '../rootIndexRuntime'

export interface ScanOrchestratorDeps {
  appendStartupLog: (message: string) => void
  emitFontIndexProgress: (payload: FontIndexProgressPayload) => void
  sendFontIndexChanged?: (payload: FontIndexChangePayload) => void
  recheckGlobalIoQueues: () => void
  globalIoSnapshot: () => IoQueueSnapshot
  withGlobalIo: <T>(label: string, task: () => Promise<T>, options?: GlobalIoOptions) => Promise<T>
  fontExtensions: Set<string>
  scriptDetectionVersion: number
  fontScanCacheVersion: number
  scanHashFlushBatchSize: number
  indexProgressEventMinIntervalMs: number
  cacheKeyForRootFile: (rootPath: string, filePath: string) => string
  cacheEntryRuntimePath: (rootPath: string, cacheKey: string) => string
  sanitizeCachedFont: (font: FontItem, cacheKey: string, filePath: string, stat: CachedFontStatLike) => FontItem
  cachedFontForRuntime: (font: FontItem, filePath: string, stat: CachedFontStatLike, cacheKey: string) => FontItem
  ensureRootScanCacheStorage: (rootPath: string) => Promise<{
    cachePath: string
    cacheDir: string
    storage: 'root' | 'fallback'
    cache: FontScanCacheFile
  }>
  loadLegacyScanCache: () => Promise<FontScanCacheFile>
  saveScanCacheFile: (filePath: string, cache: FontScanCacheFile, rootPath?: string, storage?: 'root' | 'fallback') => Promise<void>
  writeRootCacheManifest: (cacheDir: string, rootPath: string, storage: 'root' | 'fallback', count: number, cachePath: string) => Promise<void>
  openRootIndexDb: (dbPath: string, rootPath: string, storage: 'root' | 'fallback', writable: boolean) => Promise<any>
  closeSqliteDb: (db: any) => void
  withRootCacheWriteLock: <T>(filePath: string, task: () => Promise<T>) => Promise<T>
  saveRootIndexSqliteChanges: (
    dbPath: string,
    rootPath: string,
    storage: 'root' | 'fallback',
    changedEntries: Array<[string, FontScanCacheEntry]>,
    deletedKeys: string[],
  ) => Promise<void>
  upsertFontHashIndex: (fonts: FontItem[]) => Promise<void>
  recordCacheEvent: (source: string, eventType: string, payload?: Record<string, unknown>) => Promise<void>
  runRustFontIndexListWorker?: (
    folders: string[],
    extensions: string[],
    progress: (payload: { files: number; foldersScanned: number }) => void,
    signal?: AbortSignal,
  ) => Promise<{
    files: Array<{ file: string; rootPath: string; stat: CachedFontStatLike; signatureValid?: boolean; format?: string; quickHash?: string; contentHash?: string; hashKind?: string; nameHint?: RustFontNameHint; scriptHint?: RustFontScriptHint; styleHint?: RustFontStyleHint; familyHint?: RustFontFamilyHint }>
    directories?: Array<{ path: string; modifiedMs: number; fileCount: number; dirCount: number }>
    errors: Array<{ path: string; message: string }>
    foldersScanned?: number
    truncated?: boolean
    durationMs?: number
  } | null>
  runFontIndexListWorker: (
    folders: string[],
    progress: (payload: { files: number; foldersScanned: number; batch?: Array<{ file: string; rootPath: string; stat: CachedFontStatLike }> }) => void,
    signal?: AbortSignal,
  ) => Promise<{
    files: Array<{ file: string; rootPath: string; stat: CachedFontStatLike; signatureValid?: boolean; format?: string; quickHash?: string; contentHash?: string; hashKind?: string; nameHint?: RustFontNameHint; scriptHint?: RustFontScriptHint; styleHint?: RustFontStyleHint; familyHint?: RustFontFamilyHint }>
    errors: Array<{ path: string; message: string }>
  }>
  runFontParseWorkerPool: (
    jobs: FontParseJob[],
    progress: (payload: { done: number; total: number; workerCount: number }) => void,
    signal: AbortSignal | undefined,
    onResult: (result: FontParseWorkerResult) => Promise<void>,
  ) => Promise<{ workerCount: number }>

  runRustFontParseBatch?: (
    jobs: FontParseJob[],
    signal?: AbortSignal,
  ) => Promise<{
    results: FontParseJob[]
    errors?: Array<{ jobId?: string; path?: string; message?: string }>
    count?: number
    elapsedMs?: number
  } | null>
  scanWorkerCount: (jobCount: number, roots: string[]) => number
}

export interface ActiveFontScanStatus {
  running: boolean
  jobId?: string
  folders?: string[]
  startedAt?: string
  io?: { active: number; pending: number; concurrency: number }
}

export interface ScanOrchestratorRuntime {
  scanFolders: (folders: string[], knownFonts?: FontItem[], options?: { jobId?: string; signal?: AbortSignal }) => Promise<ScanResult>
  scanFoldersManaged: (folders: string[], knownFonts?: FontItem[]) => Promise<ScanResult>
  cancelActiveFontScan: (reason?: string) => { cancelled: boolean; jobId?: string; message: string }
  activeFontScanStatus: () => ActiveFontScanStatus
  isActive: () => boolean
  activeJobId: () => string
  readRootDirectorySignatures: (context: RootScanCacheContext) => Promise<Map<string, RootDirectorySignature>>
  saveRootDirectorySignatures: (context: RootScanCacheContext) => Promise<void>
  relativeDirectoryPathForRoot: (rootPath: string, dirPath: string) => string
  cacheKeyInsideDirectory: (cacheKey: string, relativeDir: string) => boolean
  listFontFilesWithDirectoryCache: (
    context: RootScanCacheContext,
    errors: ScanResult['errors'],
    progress?: (payload: { files: number; foldersScanned: number; skippedDirs: number }) => void,
    signal?: AbortSignal,
    startDir?: string,
    listedBatch?: (items: Array<{ file: string; rootPath: string; stat: CachedFontStatLike | null; error: string }>) => void,
  ) => Promise<Array<{ file: string; rootPath: string; stat: CachedFontStatLike | null; error: string }>>
}

export interface ActiveFontScanJob {
  jobId: string
  folders: string[]
  controller: AbortController
  startedAt: number
  completion: Promise<ScanResult>
}
