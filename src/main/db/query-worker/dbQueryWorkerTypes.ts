import type { FontItem,FontMetricsResult,FontQueryPageResult,FontQueryRequest,InstallCompareResult } from '../../../shared/types';

export type DbQuerySqlParts = {
  sql: string
  countSql: string
  params: unknown[]
  countParams: unknown[]
  usedLike: boolean
}

export type QueryMergedIndexPageWorkerRequest = {
  queryKey: string
  request: FontQueryRequest
  limit: number
  offset: number
  roots: string[]
  mergedIndexDbPath: string
  libraryDbPath: string
  schemaVersion: number
  sql: DbQuerySqlParts
}

export type QueryMergedIndexPageWorkerResult = FontQueryPageResult & {
  workerMode: 'db-worker-snapshot'
  timings?: Record<string, number>
}

export type QueryMergedIndexMetricsWorkerRequest = {
  roots: string[]
  mergedIndexDbPath: string
  libraryDbPath: string
  schemaVersion: number
}

export type QueryMergedIndexMetricsWorkerResult = FontMetricsResult & {
  workerMode: 'db-worker-metrics'
  timings?: Record<string, number>
}

export type InstallStatusWorkerItem = Pick<FontItem, 'id' | 'path' | 'fileName' | 'fileSize' | 'modifiedAt' | 'managedInstallPath' | 'managedRegistryName'> & {
  signature: string
}

export type InstallStatusReadWorkerGroup = {
  rootLabel: string
  rootPath: string
  dbPath: string
  items: InstallStatusWorkerItem[]
}

export type ReadInstallStatusWorkerRequest = {
  groups: InstallStatusReadWorkerGroup[]
}

export type ReadInstallStatusWorkerResult = {
  results: Record<string, InstallCompareResult>
  missingIds: string[]
  timings?: Record<string, number>
}

export type InstallStatusSaveWorkerRow = {
  fontId: string
  signature: string
  installed: boolean
  by: InstallCompareResult['by']
  matches: unknown[]
  systemDefault: boolean
}

export type InstallStatusSaveWorkerGroup = {
  rootLabel: string
  rootPath: string
  dbPath: string
  rows: InstallStatusSaveWorkerRow[]
}

export type SaveInstallStatusWorkerRequest = {
  groups: InstallStatusSaveWorkerGroup[]
}

export type SaveInstallStatusWorkerResult = {
  written: number
  groups: number
  timings?: Record<string, number>
}

export type DbWorkerRequestMessage =
  | { id: number; type: 'queryMergedIndexPage'; payload: QueryMergedIndexPageWorkerRequest }
  | { id: number; type: 'queryMergedIndexMetrics'; payload: QueryMergedIndexMetricsWorkerRequest }
  | { id: number; type: 'readInstallStatusIndex'; payload: ReadInstallStatusWorkerRequest }
  | { id: number; type: 'saveInstallStatusIndex'; payload: SaveInstallStatusWorkerRequest }

export type DbWorkerResult =
  | QueryMergedIndexPageWorkerResult
  | QueryMergedIndexMetricsWorkerResult
  | ReadInstallStatusWorkerResult
  | SaveInstallStatusWorkerResult

export type DbWorkerResponseMessage =
  | { id: number; ok: true; result: DbWorkerResult }
  | { id: number; ok: false; error: string; code?: string }

export type PendingRequest<T = DbWorkerResult> = {
  resolve: (value: T) => void
  reject: (reason: Error) => void
  startedAt: number
  type: DbWorkerRequestMessage['type']
}


export type DbQueryWorkerRuntimeDeps = {
  dataPath: (...segments: string[]) => string
  appendStartupLog: (message: string) => void
  resolveModulePath?: (moduleName: string) => string
}
