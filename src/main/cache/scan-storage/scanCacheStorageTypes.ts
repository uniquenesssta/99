import type { CacheStats,LibraryShell } from '../../../shared/types'
import type { FontScanCacheFile } from '../../indexing/rootIndexRuntime'

export type RootIndexStorage = 'root' | 'fallback'
export type PreviewStorage = 'root' | 'fallback' | 'local'

export type SqliteDb = any

export type ScanCacheStorageRuntimeOptions = {
  appName: string
  fontScanCacheVersion: number
  previewSqliteSchemaVersion: number
  legacyScanCachePath: () => string
  fallbackCacheRootDir: (rootPath: string) => string
  fallbackScanCachePath: (rootPath: string) => string
  fallbackLegacyScanCachePath: (rootPath: string) => string
  rootCacheDir: (rootPath: string) => string
  rootScanCachePath: (rootPath: string) => string
  rootLegacyScanCachePath: (rootPath: string) => string
  rootIndexDbDir: (rootPath: string) => string
  rootIndexDbPath: (rootPath: string) => string
  rootCacheLockDir: (rootPath: string) => string
  rootIndexLockPath: (rootPath: string) => string
  fallbackIndexDbPath: (rootPath: string) => string
  rootPreviewCacheDir: (rootPath: string) => string
  legacyRootPreviewCacheDir: (rootPath: string) => string
  rootPreviewImageDir: (rootPath: string) => string
  rootPreviewDbPath: (rootPath: string) => string
  fallbackPreviewCacheDir: (rootPath: string) => string
  fallbackPreviewImageDir: (rootPath: string) => string
  fallbackPreviewDbPath: (rootPath: string) => string
  localPreviewImageDir: () => string
  previewSqlitePath: () => string
  loadLibraryShell: () => Promise<LibraryShell>
  exists: (filePath: string) => Promise<boolean>
  sha1: (value: string) => string
  appendStartupLog: (message: string) => void
  ensureRootArchitectureDatabases: (rootPath: string) => Promise<void>
  resolveActiveRootIndexDbPath: (cacheDir: string, defaultDbPath: string) => Promise<string>
  readRootIndexSqliteFile: (filePath: string, rootPath: string, storage: RootIndexStorage) => Promise<FontScanCacheFile>
  saveRootIndexSqliteFile: (filePath: string, rootPath: string, storage: RootIndexStorage, cache: FontScanCacheFile) => Promise<void>
  writeRootCacheManifest: (cacheDir: string, rootPath: string, storage: RootIndexStorage, fileCount: number, dbPath: string) => Promise<void>
  withRootCacheWriteLock: <T>(filePath: string, fn: () => Promise<T>) => Promise<T>
  listRootIndexDatabaseFiles: (cacheDir: string, defaultDbPath: string) => Promise<string[]>
  openStableSqliteDb: (filePath: string, label: string) => SqliteDb
  closeSqliteDb: (db: SqliteDb) => void
  initializePreviewDb: (db: SqliteDb) => void
  recoveryMessage: (error: unknown) => string
  quarantineSqliteFiles: (dbPath: string, label: string, reason: string, quarantineDir?: string) => Promise<string | undefined>
  clearLocalPreviewDbHandle: () => void
}

export type ScanCacheStatsReader = () => Promise<CacheStats>
