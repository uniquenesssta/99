import type { FontItem,InstallCompareResult,SystemInstalledFont } from '../../../shared/types'

export type SqliteDb = any

export type InstallStatusWorkerItem = Pick<FontItem, 'id' | 'path' | 'fileName' | 'fileSize' | 'modifiedAt' | 'managedInstallPath' | 'managedRegistryName'> & { signature: string }

export type InstallStatusReadWorkerGroup = {
  rootLabel: string
  rootPath: string
  dbPath: string
  items: InstallStatusWorkerItem[]
}

export type InstallStatusSaveWorkerGroup = {
  rootLabel: string
  rootPath: string
  dbPath: string
  rows: Array<{
    fontId: string
    signature: string
    installed: boolean
    by: InstallCompareResult['by']
    matches: SystemInstalledFont[]
    systemDefault: boolean
  }>
}

export type InstallStatusRuntimeDeps = {
  rootCacheDir: (rootPath: string) => string
  dataPath: (...parts: string[]) => string
  cacheIdentityPath: () => string
  ensureCacheIdentity: () => Promise<void>
  appWatchedFolders: () => Promise<string[]>
  findBestWatchedRootForFile: (filePath: string, folders: string[]) => string | null
  openStableSqliteDb: (dbPath: string, label: string) => SqliteDb
  closeSqliteDb: (db: SqliteDb) => void
  setSqliteMeta: (db: SqliteDb, key: string, value: string) => void
  getSqliteMeta: (db: SqliteDb, key: string) => string | undefined
  parseSqliteJson: <T>(value: unknown, fallback: T) => T
  exists: (filePath: string) => Promise<boolean>
  sha1: (value: string) => string
  normalizePathForCacheCompare: (value: string) => string
  isCleanWindowsDefaultCompareResult: (item: FontItem, result: InstallCompareResult) => boolean
  completeBackgroundTask: (taskKey: string, summary?: string) => Promise<void>
  appendStartupLog: (message: string) => void
  readInstallStatusIndexInWorker?: (groups: InstallStatusReadWorkerGroup[]) => Promise<{ results: Record<string, InstallCompareResult>; missingIds: string[]; timings?: Record<string, number> }>
  saveInstallStatusIndexInWorker?: (groups: InstallStatusSaveWorkerGroup[]) => Promise<{ written: number; groups: number; timings?: Record<string, number> }>
}

export type InstallStatusDbRuntime = {
  installStatusDbPathForRoot: (rootPath: string) => Promise<string>
  fallbackInstallStatusDbPath: () => Promise<string>
  rootForFontPath: (fontPath: string, folders?: string[]) => Promise<string | null>
  openMachineInstallDbForRoot: (rootPath: string) => Promise<SqliteDb>
  openFallbackInstallDb: () => Promise<SqliteDb>
  initializeMachineInstallDb: (db: SqliteDb, rootPath: string) => void
}

export type InstallStatusSignatureRuntime = {
  installStatusTaskKey: (fontId: string) => string
  installStatusSignature: (item: FontItem) => string
  installStatusWorkerItem: (item: FontItem) => InstallStatusWorkerItem
}

export type InstallStatusNormalizeRuntime = {
  normalizeInstallCompareResult: (result: Partial<InstallCompareResult> | null | undefined) => InstallCompareResult | null
}
