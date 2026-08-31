import type { FontItem } from '../../../shared/types'

export type RootIndexStorage = 'root' | 'fallback'

export interface FontScanCacheEntry {
  path: string
  cacheKey: string
  fileSize: number
  modifiedAt: number
  createdAt?: number
  status: 'ok' | 'bad'
  font?: FontItem
  message?: string
  contentHash?: string
  cachedAt: string
}

export interface FontScanCacheFile {
  version: number
  entries: Record<string, FontScanCacheEntry>
}

export interface RootCacheManifestFile {
  version?: number
  app?: string
  storage?: RootIndexStorage | string
  rootPath?: string
  rootId?: string
  canonicalPath?: string
  aliases?: string[]
  cacheType?: string
  cacheSafety?: string
  indexDatabase?: string
  activeDatabase?: string
  latestPointer?: string
  lockFile?: string
  fileCount?: number
  schemaVersion?: number
  indexCacheVersion?: number
  scriptDetectionVersion?: number
  updatedAt?: string
}


export type RustRootIndexApplyChangesRequest = {
  dbPath: string
  rootPath: string
  storage: RootIndexStorage
  schemaVersion: number
  cacheVersion: number
  scriptDetectionVersion: number
  upserts: Array<[string, FontScanCacheEntry]>
  deletes: string[]
}

export type RustRootIndexApplyChangesResult = {
  applied: boolean
  count: number
  upserts: number
  deletes: number
  durationMs?: number
}

export class RootCacheLockTimeoutError extends Error {
  constructor(lockPath: string) {
    super(`root cache lock timeout: ${lockPath}`)
    this.name = 'RootCacheLockTimeoutError'
  }
}

export type RootIndexRuntimeDeps = {
  appName: string
  fontScanCacheVersion: number
  scriptDetectionVersion: number
  exists: (filePath: string) => Promise<boolean>
  openStableSqliteDb: (filePath: string, label: string) => any
  closeSqliteDb: (db: any) => void
  appendStartupLog: (line: string) => void
  withGlobalIo: <T>(label: string, fn: () => Promise<T>, options?: any) => Promise<T>
  invalidateSharedFontRuntimeCaches: () => void
  recordCacheEvent: (source: string, eventType: string, payload?: Record<string, unknown>) => Promise<void>
  runRustRootIndexApplyChanges?: (input: RustRootIndexApplyChangesRequest) => Promise<RustRootIndexApplyChangesResult | null>
}
