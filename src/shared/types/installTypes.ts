import type { FontItem, SystemInstalledFont } from './fontTypes'

export interface InstallCompareResult {
  installed: boolean
  by: 'managed' | 'system' | 'both' | 'user' | 'none'
  matches: SystemInstalledFont[]
}

export interface InstallCompareOptions {
  force?: boolean
  incremental?: boolean
}

export interface InstallStatusRefreshStartResult {
  started: boolean
  running?: boolean
  jobId?: string
  message: string
}

export interface InstallStatusProgressPayload {
  jobId: string
  stage: 'start' | 'reading' | 'comparing' | 'writing' | 'done' | 'cancelled' | 'error'
  message: string
  at: string
  total?: number
  processed?: number
  installedCount?: number
  installedTotalCount?: number
  updatedCount?: number
  missingCount?: number
  elapsedMs?: number
}

export interface InstallStatusRefreshResult {
  mode?: 'full' | 'incremental' | 'skipped'
  total: number
  installedCount: number
  installedTotalCount?: number
  notInstalledCount: number
  systemMatchedCount: number
  systemDefaultCount: number
  managedCount: number
  updatedCount: number
  elapsedMs: number
  missingCount?: number
}

export interface InstallResult {
  ok: boolean
  managedInstallPath?: string
  managedRegistryName?: string
  temporaryActivated?: boolean
  message: string
}

export interface FontActivationBatchItemResult extends InstallResult {
  id: string
  fileName?: string
  status?: 'activated' | 'already-active' | 'already-installed' | 'failed' | 'cancelled'
  retryable?: boolean
}

export interface FontActivationBatchResult {
  ok: boolean
  activated: number
  deactivated?: number
  skippedInstalled: number
  skippedAlreadyActive: number
  failed: number
  cancelled?: number
  results: Record<string, FontActivationBatchItemResult>
  message: string
}

export interface FontTagBatchItem {
  item: FontItem
  tagNames: string[]
}

export interface FontTagMutationProtocolResult {
  ok?: boolean
  message?: string
  command?: string
  domain?: string
  mutationKind?: string
  source?: string
  changedIds?: string[]
  updatedAt?: string
  dbPath?: string
  rootPath?: string
  knownTags?: string[]
  signature?: string
  cacheInvalidated?: boolean
  mergedIndexDirty?: boolean
  pageQueryDirty?: boolean
  metricsDirty?: boolean
  stateSignal?: Record<string, unknown>
  timings?: Record<string, number>
  workerMode?: string
}

export interface FontTagUpdateResult {
  ok: boolean
  updatedIds: string[]
  failed: Array<{ id: string; fileName: string; message: string }>
  message: string
  mutationProtocol?: FontTagMutationProtocolResult
}

export interface FontProtectionResult {
  ok: boolean
  updatedIds: string[]
  failed: Array<{ id: string; fileName: string; message: string }>
  message: string
}

export interface FontDeleteResult {
  ok: boolean
  deletedIds: string[]
  deleted: number
  skippedProtected: number
  skippedInstalled: number
  skippedUnsafe: number
  failed: Array<{ id: string; fileName: string; message: string }>
  message: string
}

export interface MoveFontFileResult {
  ok: boolean
  message: string
  oldPath?: string
  newPath?: string
}

export interface MoveFontFilesResult {
  ok: boolean
  moved: Array<{ id: string; result: MoveFontFileResult }>
  movedCount: number
  failed: Array<{ id: string; fileName: string; message: string }>
  message: string
}

export interface RenameFolderResult {
  ok: boolean
  message: string
  oldPath?: string
  newPath?: string
}
