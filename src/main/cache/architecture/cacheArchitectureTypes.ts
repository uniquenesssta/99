export type ApplicationCacheDbLabel = 'kvs' | 'events' | 'hash' | 'metrics'

export type CacheArchitectureInfo = {
  version: number
  identityPath: string
  dataRoot: string
  databases: Record<string, string>
  startupPolicy: {
    autoScan: boolean
    autoSystemFontImport: boolean
    recoverScanTasks: boolean
    watcherGraceMs: number
    backgroundTasks: boolean
  }
}

export type CacheArchitectureRuntimeOptions = {
  appName: string
  cacheArchitectureVersion: number
  kvsSqliteSchemaVersion: number
  eventsSqliteSchemaVersion: number
  hashSqliteSchemaVersion: number
  metricsSqliteSchemaVersion: number
  watcherStartupGraceMs: number
  rootCacheDirName: string
  rootIndexDbDirName: string
  rootIndexDbFileName: string
  rootPreviewCacheDirName: string
  previewCacheDbDirName: string
  previewCacheDbFileName: string
  previewCacheImagesDirName: string
  appSqlitePath: () => string
  previewSqlitePath: () => string
  kvsSqlitePath: () => string
  eventsSqlitePath: () => string
  hashSqlitePath: () => string
  metricsSqlitePath: () => string
  cacheIdentityPath: () => string
  dataRoot: () => string
  exists: (filePath: string) => Promise<boolean>
  writeJsonAtomic: (filePath: string, value: unknown) => Promise<void>
  openRecoverableApplicationSqliteDb: (filePath: string, label: ApplicationCacheDbLabel) => Promise<any>
  closeSqliteDb: (db: any) => void
  setSqliteMeta: (db: any, key: string, value: string) => void
  normalizePathForCacheCompare: (filePath: string) => string
  fileCacheSignature: (filePath: string, fileSize: number, modifiedAt: number) => string
  sha1: (value: string) => string
  appendStartupLog: (message: string) => void
}
