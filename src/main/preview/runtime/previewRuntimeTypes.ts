import type { LibraryState } from '../../../shared/types'
import type { AuthorizeFontRead } from '../../path/fontPathAuthorizationRuntime'
import type { PreviewCacheIndexStatus,PreviewCacheRow } from '../previewCacheRuntime'

export interface PreviewSharedCacheStorage {
  dir: string
  identity: string
  storage: 'root'
  rootPath: string
  indexDbPath: string
}

export interface PreviewCacheStorage {
  dir: string
  identity: string
  storage: 'root' | 'fallback' | 'local'
  rootPath?: string
  indexDbPath?: string
  shared?: PreviewSharedCacheStorage
}

export interface PreviewImageFileResult {
  outputPath: string
  cached: boolean
  storage: 'root' | 'fallback' | 'local'
}

export interface PreviewRuntimeOptions {
  cacheKeyForRootFile: (rootPath: string, filePath: string) => string
  rootPreviewCacheDir: (rootPath: string) => string
  rootPreviewImageDir: (rootPath: string) => string
  rootPreviewDbPath: (rootPath: string) => string
  hideDirectoryOnWindows: (dir: string) => Promise<void>
  writeRootPreviewCacheManifest: (cacheDir: string, rootPath: string, storage: 'root' | 'local' | 'fallback', previewDbPath: string, previewImageDir: string) => Promise<void>
  appendStartupLog: (message: string) => void
  localPreviewImageDir: () => string
  cacheKeyForPath: (filePath: string) => string
  sha1: (value: string) => string
  openPreviewDb: () => Promise<any>
  previewSqlitePath: () => string
  openStableSqliteDb: (dbPath: string, label: string) => any
  initializePreviewDb: (db: any) => void
  closeSqliteDb: (db: any) => void
  normalizePathForCacheCompare: (value: string) => string
  normalizePreviewCacheIndexStatus: (status?: string | null) => PreviewCacheIndexStatus | null
  upsertPreviewCacheRows: (db: any, rows: PreviewCacheRow[]) => void
  loadLibraryShell: () => Promise<LibraryState>
  ensureWindows: () => void
  resolveExistingFontFilePath: (rawPath?: string, options?: { logMissing?: boolean; logResolved?: boolean }) => Promise<string | undefined>
  authorizeFontRead: AuthorizeFontRead
  previewTaskKey: (key: string) => string
  completeBackgroundTask: (taskKey: string, message?: string) => Promise<void>
  skipBackgroundTask: (taskKey: string, message?: string) => Promise<void>
  upsertBackgroundTask: (taskKey: string, type: any, priority: number, payload: Record<string, unknown>, status?: any, message?: string) => Promise<void>
  startBackgroundTask: (taskKey: string) => Promise<any>
  heartbeatBackgroundTask: (taskKey: string, progress?: number, message?: string) => Promise<void>
  failBackgroundTask: (taskKey: string, message: string, stack?: string) => Promise<void>
  legacyRootPreviewCacheDir: (rootPath: string) => string
  execFileAsync: (file: string, args?: readonly string[], options?: any) => Promise<{ stdout: string; stderr: string }>
  withGlobalIo: <T>(label: string, fn: () => Promise<T>, options?: any) => Promise<T>
  missingFontPreviewDataUri: (filePath: string, width: number, height: number) => string
  previewSqliteSchemaVersion: number
  runRustPreviewCacheReadStatus?: (input: { dbPath: string; schemaVersion: number; previewKey: string; outputPath: string; now: string }) => Promise<{ status: PreviewCacheIndexStatus | null; matched: boolean; touched: boolean } | null>
  runRustPreviewCacheApply?: (input: { dbPath: string; schemaVersion: number; rows: PreviewCacheRow[] }) => Promise<{ written: number } | null>
  runRustPreviewCacheDelete?: (input: { dbPath: string; schemaVersion: number; keys: string[] }) => Promise<{ deleted: number } | null>
  runRustPreviewCacheQuery?: (input: { dbPath: string; schemaVersion: number; rows: Array<{ id: string; previewKey: string; outputPath: string }>; acceptedStatuses: PreviewCacheIndexStatus[]; touchMatched: boolean; now: string }) => Promise<{ rows: Array<{ id: string; previewKey: string; outputPath: string; status: PreviewCacheIndexStatus | null; matched: boolean }>; matched: number; touched: number } | null>
  runRustPreviewCacheBatch?: (input: { dbPath: string; schemaVersion: number; rows: Array<{ id: string; previewKey: string; outputPath: string }>; acceptedStatuses: PreviewCacheIndexStatus[]; touchMatched: boolean; checkFiles?: boolean; now: string }) => Promise<{ rows: Array<{ id: string; previewKey: string; outputPath: string; status: PreviewCacheIndexStatus | null; matched: boolean; fileExists?: boolean }>; matched: number; touched: number; missingIds: string[] } | null>
  runRustPreviewCacheTouch?: (input: { dbPath: string; schemaVersion: number; keys: string[]; now: string }) => Promise<{ touched: number } | null>
  runRustPreviewRenderImage?: (input: { fontPath: string; text: string; fontSize: number; width: number; height: number; outputPath: string; preferSystemFont?: boolean; systemFontFamilyCandidates?: string[] }) => Promise<{ ok: boolean; engine: 'rust-directwrite'; outputPath: string } | null>
}
