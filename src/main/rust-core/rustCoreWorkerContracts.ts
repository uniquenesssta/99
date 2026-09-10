// Stable public worker types. Runtime consumers use the facade; type consumers use this module.
import type { CachedFontStatLike } from '../fonts/fontRuntime'
import type {
  FontMetricsResult,
  FontQueryPageResult,
  FontQueryRequest,
  FontItem,
  InstallCompareResult,
  SystemInstalledFont,
  FontTagRevisionMetadata,
} from '../../shared/types'
import type {
  PreviewCacheIndexStatus,
  PreviewCacheRow,
} from '../preview/previewCacheRuntime'
import type { FontParseJob } from '../indexing/fontScanWorkers'
import type {
  DatabaseBackupReport,
  DatabaseHealthItem,
} from '../maintenance/databaseMaintenanceTypes'
import type { RustCoreDaemonDomainEvent } from './rustCoreDaemonRuntime'

export type RustCoreWorkerStatus = {
  available: boolean
  path?: string
  version?: string
  protocolVersion?: number
  capabilities?: string[]
  message?: string
}

export type RustFontScriptHint = {
  scripts?: string[]
  rangeCount?: number
  sourceIndex?: number
}

export type RustFontStyleHint = {
  weightClass?: number
  widthClass?: number
  italic?: boolean
  bold?: boolean
  monospaced?: boolean
  unitsPerEm?: number
  glyphCount?: number
  sourceIndex?: number
}

export type RustFontFamilyHint = {
  familyName?: string
  styleName?: string
  familyKey?: string
  styleKey?: string
  weightClass?: number
  widthClass?: number
  italic?: boolean
  bold?: boolean
  monospaced?: boolean
  sourceIndex?: number
}

export type RustFontNameHint = {
  familyName?: string
  subfamilyName?: string
  fullName?: string
  postscriptName?: string
  preferredFamily?: string
  preferredSubfamily?: string
  displayFamily?: string
  displaySubfamily?: string
  version?: string
  manufacturer?: string
  recordCount?: number
  sourceIndex?: number
}

export type RustListedFontFile = {
  file: string
  rootPath: string
  stat: CachedFontStatLike
  signatureValid?: boolean
  format?: string
  quickHash?: string
  contentHash?: string
  hashKind?: string
  nameHint?: RustFontNameHint
  scriptHint?: RustFontScriptHint
  styleHint?: RustFontStyleHint
  familyHint?: RustFontFamilyHint
}

export type RustListedDirectory = {
  path: string
  modifiedMs: number
  fileCount: number
  dirCount: number
}

export type RustFontIndexListResult = {
  files: RustListedFontFile[]
  directories: RustListedDirectory[]
  errors: Array<{ path: string; message: string }>
  foldersScanned: number
  truncated: boolean
  durationMs: number
}

export type RustFontParseBatchResult = {
  results: FontParseJob[]
  errors: Array<{ jobId?: string; path?: string; message?: string }>
  count: number
  elapsedMs: number
  workerMode: 'rust-font-parse-batch'
}

export type RustRootIndexApplyChangesInput = {
  dbPath: string
  rootPath: string
  storage: 'root' | 'fallback'
  schemaVersion: number
  cacheVersion: number
  scriptDetectionVersion: number
  upserts: Array<[string, unknown]>
  deletes: string[]
}

export type RustRootIndexApplyChangesResult = {
  applied: boolean
  count: number
  upserts: number
  deletes: number
  durationMs: number
}

export type RustMergedIndexPageQueryInput = {
  queryKey: string
  request: FontQueryRequest
  limit: number
  offset: number
  roots: string[]
  mergedIndexDbPath: string
  libraryDbPath: string
  schemaVersion: number
  tagRevision?: FontTagRevisionMetadata | Record<string, unknown>
  sql: {
    sql: string
    countSql: string
    params: unknown[]
    countParams: unknown[]
    usedLike: boolean
  }
}

export type RustMergedIndexPageQueryResult = FontQueryPageResult & {
  workerMode: 'rust-merged-index-page'
  timings?: Record<string, number>
}

export type RustMergedIndexIdsQueryInput = {
  queryKey: string
  request: FontQueryRequest
  limit: number
  roots: string[]
  mergedIndexDbPath: string
  libraryDbPath: string
  schemaVersion: number
  tagRevision?: FontTagRevisionMetadata | Record<string, unknown>
  sql: {
    sql: string
    params: unknown[]
    usedLike: boolean
  }
}

export type RustMergedIndexIdsQueryResult = {
  queryKey: string
  ids: string[]
  total: number
  limit: number
  truncated: boolean
  engine: 'like' | 'sql'
  elapsedMs: number
  workerMode: 'rust-merged-index-ids'
  tagRevision?: FontTagRevisionMetadata
  timings?: Record<string, number>
}

export type RustMergedIndexMetricsQueryInput = {
  roots: string[]
  mergedIndexDbPath: string
  libraryDbPath: string
  schemaVersion: number
  tagRevision?: FontTagRevisionMetadata | Record<string, unknown>
}

export type RustMergedIndexMetricsQueryResult = FontMetricsResult & {
  workerMode: 'rust-merged-index-metrics'
  timings?: Record<string, number>
}

export type RustMergedIndexMutationProtocol = {
  ok?: boolean
  command?: string
  domain?: string
  mutationKind?: string
  source?: string
  updatedAt?: string
  sourcesKey?: string
  rows?: number
  changed?: number
  fullSnapshot?: boolean
  reason?: string
  cacheInvalidated?: boolean
  mergedIndexDirty?: boolean
  pageQueryDirty?: boolean
  metricsDirty?: boolean
  workerMode?: string
}

export type RustMergedIndexRebuildSource = {
  root: string
  indexDbPath: string
  installDbPath?: string
  indexSignature: string
  installSignature: string
  sharedMetadataSignature?: string
}

export type RustMergedIndexRebuildInput = {
  mergedIndexDbPath: string
  schemaVersion: number
  sourcesKey: string
  syncedAt: string
  sources: RustMergedIndexRebuildSource[]
}

export type RustMergedIndexRebuildResult = {
  rebuilt: boolean
  rows: number
  elapsedMs: number
  workerMode: 'rust-merged-index-rebuild'
  indexProtocol?: RustMergedIndexMutationProtocol
  timings?: Record<string, number>
}

export type RustMergedIndexSyncInput = {
  mergedIndexDbPath: string
  schemaVersion: number
  sourcesKey: string
  syncedAt: string
  source: RustMergedIndexRebuildSource
  relativePaths?: string[]
  fullSnapshot?: boolean
  reason?: string
}

export type RustMergedIndexSyncResult = {
  synced: boolean
  changed: number
  rows: number
  fullSnapshot: boolean
  elapsedMs: number
  workerMode: 'rust-merged-index-sync'
  indexProtocol?: RustMergedIndexMutationProtocol
  timings?: Record<string, number>
}

export type RustSystemInstalledFontsInput = {
  windowsFontsDir: string
  currentUserFontsDir: string
  extensions: string[]
  includeNameCandidates?: boolean
}

export type RustSystemInstalledFontsResult = {
  items: SystemInstalledFont[]
  count: number
  registryCount: number
  folderCount: number
  elapsedMs: number
  workerMode: 'rust-system-installed-fonts'
}

export type RustWatcherPreflightInput = {
  rootPath: string
  dbPath: string
  extensions: string[]
  changes: Array<{ eventType: string; fileName: string }>
}

export type RustWatcherPreflightResult = {
  unchanged: boolean
  reason: string
  checkedFiles: number
  checkedDirs: number
  elapsedMs: number
  workerMode: 'rust-watcher-preflight'
}

export type RustInstallStatusReadResult = {
  results: Record<string, InstallCompareResult>
  missingIds: string[]
  timings?: Record<string, number>
  workerMode: 'rust-install-status-read'
}

export type RustInstallStatusSaveResult = {
  written: number
  groups: number
  timings?: Record<string, number>
  workerMode: 'rust-install-status-save'
}

export type RustInstallStatusCompareInput = {
  appName: string
  items: FontItem[]
  installed: SystemInstalledFont[]
}

export type RustInstallStatusCompareResult = {
  results: Record<string, InstallCompareResult>
  count: number
  elapsedMs: number
  workerMode: 'rust-install-status-compare'
}

export type RustLocalTagsSetRow = {
  itemId: string
  aliases: string[]
  fontPath: string
  tagNames: string[]
}

export type RustLocalTagsReadRow = {
  itemId: string
  aliases: string[]
  fontPath: string
}

export type RustLocalTagsReadInput = {
  dbPath: string
  rows: RustLocalTagsReadRow[]
}

export type RustLocalTagsReadResult = {
  tagMap: Record<string, string[]>
  knownTags: string[]
  signature?: string
  timings?: Record<string, number>
  workerMode: 'rust-local-tags-read'
}

export type RustLocalTagsSetInput = {
  dbPath: string
  updatedAt: string
  rows: RustLocalTagsSetRow[]
}

export type RustLocalTagsDeleteTagInput = {
  dbPath: string
  tagName: string
  updatedAt: string
}

export type RustLocalTagsMutationStateSignal = {
  mutationKind?: string
  dbPath?: string
  changedIds?: string[]
  updatedAt?: string
  localTagsChanged?: boolean
  cacheInvalidated?: boolean
  pageQueryDirty?: boolean
  metricsDirty?: boolean
  knownTags?: string[]
  source?: 'rust-worker' | 'node-fallback' | 'rust-daemon'
}

export type RustLocalTagsSetResult = {
  updatedIds: string[]
  written: number
  previousKnownTags?: string[]
  knownTags: string[]
  addedKnownTags?: string[]
  removedKnownTags?: string[]
  retainedEmptyTags?: string[]
  stateSignal?: RustLocalTagsMutationStateSignal
  mutationProtocol?: RustTagMutationProtocolResult
  timings?: Record<string, number>
  workerMode: 'rust-local-tags-set'
}

export type RustLocalTagsDeleteTagResult = {
  updatedIds: string[]
  updated: number
  previousKnownTags?: string[]
  knownTags: string[]
  addedKnownTags?: string[]
  removedKnownTags?: string[]
  stateSignal?: RustLocalTagsMutationStateSignal
  mutationProtocol?: RustTagMutationProtocolResult
  timings?: Record<string, number>
  workerMode: 'rust-local-tags-delete'
}

export type RustSharedMetadataApplyRow = {
  fontId: string
  relativePath: string
  pathKey: string
  tagNamesJson: string
  favorite: boolean
  deleteProtected: boolean
  eventType?: string
  payloadJson?: string
  baseTagNamesJson?: string
  mergePolicy?: 'replace' | 'tags' | 'favorite' | 'deleteProtected'
}

export type RustSharedMetadataApplyInput = {
  dbPath: string
  rootPath: string
  updatedAt: string
  updatedBy: string
  writerPid: number
  rows: RustSharedMetadataApplyRow[]
}

export type RustSharedMetadataMutationStateSignal = {
  mutationKind?: string
  dbPath?: string
  rootPath?: string
  changedIds?: string[]
  updatedAt?: string
  signature?: string
  sharedMetadataChanged?: boolean
  cacheInvalidated?: boolean
  mergedIndexDirty?: boolean
  pageQueryDirty?: boolean
  metricsDirty?: boolean
  source?: 'rust-worker' | 'node-fallback' | 'rust-daemon'
}

export type RustTagMutationProtocolResult = {
  ok?: boolean
  message?: string
  command?: string
  domain?: 'localTags' | 'sharedMetadata' | string
  mutationKind?: string
  source?: 'rust-worker' | 'node-fallback' | 'rust-daemon' | string
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

export type RustSharedMetadataApplyResult = {
  written: number
  events: number
  changedIds?: string[]
  signature?: string
  stateSignal?: RustSharedMetadataMutationStateSignal
  mutationProtocol?: RustTagMutationProtocolResult
  timings?: Record<string, number>
  workerMode: 'rust-shared-metadata-apply'
}

export type RustSharedMetadataRemoveTagInput = {
  dbPath: string
  rootPath?: string
  tagName: string
  updatedAt: string
  updatedBy: string
  writerPid: number
}

export type RustSharedMetadataRemoveTagResult = {
  updatedIds: string[]
  updated: number
  signature?: string
  stateSignal?: RustSharedMetadataMutationStateSignal
  mutationProtocol?: RustTagMutationProtocolResult
  timings?: Record<string, number>
  workerMode: 'rust-shared-metadata-remove-tag'
}

export type RustSharedMetadataSignatureInput = {
  dbPath: string
}

export type RustSharedMetadataKnownTagsInput = {
  roots: Array<{ rootPath: string; dbPath: string }>
}

export type RustSharedMetadataKnownTagsResult = {
  knownTags: string[]
  roots: Array<{ rootPath: string; dbPath: string; signature: string; knownTags: string[]; rows: number }>
  timings?: Record<string, number>
  workerMode: 'rust-shared-metadata-known-tags'
}

export type RustSharedMetadataOverlayReadEntry = {
  key: string
  fontId?: string
  relativePath?: string
  pathKey?: string
}

export type RustSharedMetadataOverlayReadInput = {
  rootPath: string
  dbPath: string
  entries: RustSharedMetadataOverlayReadEntry[]
}

export type RustSharedMetadataOverlayMatchedEntry = {
  key: string
  tagNames: string[]
  favorite: boolean
  deleteProtected: boolean
  matchedBy?: string
}

export type RustSharedMetadataOverlayReadResult = {
  rootPath: string
  dbPath: string
  signature: string
  matched: RustSharedMetadataOverlayMatchedEntry[]
  rows: number
  requested: number
  timings?: Record<string, number>
  workerMode: 'rust-shared-metadata-overlay-read'
}

export type RustSharedMetadataSignatureResult = {
  signature: string
  timings?: Record<string, number>
  workerMode: 'rust-shared-metadata-signature'
}

export type RustPreviewCacheReadStatusInput = {
  dbPath: string
  schemaVersion: number
  previewKey: string
  outputPath: string
  now: string
}

export type RustPreviewCacheReadStatusResult = {
  status: PreviewCacheIndexStatus | null
  matched: boolean
  touched: boolean
  timings?: Record<string, number>
  workerMode: 'rust-preview-cache-read-status'
}

export type RustPreviewCacheApplyInput = {
  dbPath: string
  schemaVersion: number
  rows: PreviewCacheRow[]
}

export type RustPreviewCacheApplyResult = {
  written: number
  timings?: Record<string, number>
  workerMode: 'rust-preview-cache-apply'
}

export type RustPreviewCacheDeleteInput = {
  dbPath: string
  schemaVersion: number
  keys: string[]
}

export type RustPreviewCacheDeleteResult = {
  deleted: number
  timings?: Record<string, number>
  workerMode: 'rust-preview-cache-delete'
}

export type RustPreviewCacheQueryRow = {
  id: string
  previewKey: string
  outputPath: string
}

export type RustPreviewCacheQueryInput = {
  dbPath: string
  schemaVersion: number
  rows: RustPreviewCacheQueryRow[]
  acceptedStatuses: PreviewCacheIndexStatus[]
  touchMatched: boolean
  now: string
}

export type RustPreviewCacheQueryMatch = RustPreviewCacheQueryRow & {
  status: PreviewCacheIndexStatus | null
  matched: boolean
}

export type RustPreviewCacheQueryResult = {
  rows: RustPreviewCacheQueryMatch[]
  matched: number
  touched: number
  timings?: Record<string, number>
  workerMode: 'rust-preview-cache-query'
}

export type RustPreviewCacheTouchInput = {
  dbPath: string
  schemaVersion: number
  keys: string[]
  now: string
}

export type RustPreviewCacheTouchResult = {
  touched: number
  timings?: Record<string, number>
  workerMode: 'rust-preview-cache-touch'
}

export type RustPreviewCacheBatchInput = RustPreviewCacheQueryInput & {
  checkFiles?: boolean
}

export type RustPreviewCacheBatchMatch = RustPreviewCacheQueryMatch & {
  fileExists?: boolean
}

export type RustPreviewCacheBatchResult = {
  rows: RustPreviewCacheBatchMatch[]
  matched: number
  touched: number
  missingIds: string[]
  timings?: Record<string, number>
  workerMode: 'rust-preview-cache-batch'
}

export type RustPreviewCacheMaintenanceInput = {
  dbPath: string
  schemaVersion: number
  now: string
  previewDirs: string[]
  previewOkRetentionMs: number
  orphanRetentionMs: number
}

export type RustPreviewCacheMaintenanceResult = {
  checkedRows: number
  staleRows: number
  removedFiles: number
  removedOrphanFiles: number
  errors: string[]
  timings?: Record<string, number>
  workerMode: 'rust-preview-cache-maintenance'
}

export type RustPhysicalFolderTreeInput = {
  folders: string[]
}

export type RustPhysicalFolderTreeResult = {
  folders: string[]
  nodes: Array<{ id: string; name: string; parentId: string; rootPath: string; createdAt: string }>
  errors: string[]
  elapsedMs: number
  workerMode: 'rust-physical-folder-tree'
}

export type RustFontActivationFileCopy = {
  id: string
  source: string
  dest: string
}

export type RustFontActivationFilesInput = {
  copies?: RustFontActivationFileCopy[]
  deletes?: string[]
  allowedDeleteDir?: string
  allowedNamePrefix?: string
}

export type RustFontActivationFilesResult = {
  ok: boolean
  copied: number
  reused: number
  deleted: number
  failed: number
  copyResults: Array<{ id: string; source: string; dest: string; ok: boolean; mode: string; message: string }>
  deleteResults: Array<{ path: string; ok: boolean; message: string }>
  elapsedMs: number
  workerMode: 'rust-font-activation-files'
}

export type RustDatabaseMaintenanceFileItem = {
  label: string
  filePath: string
}

export type RustDatabaseHealthCheckInput = {
  items: RustDatabaseMaintenanceFileItem[]
  busyTimeoutMs?: number
}

export type RustDatabaseHealthCheckResult = {
  items: DatabaseHealthItem[]
  elapsedMs: number
  workerMode: 'rust-database-health-check'
}

export type RustDatabaseBackupInput = {
  appName: string
  schemaVersion: number
  dataRoot: string
  backupsRoot: string
  retentionCount: number
  reason: string
  createdAt: string
  backupDirName: string
  items: RustDatabaseMaintenanceFileItem[]
  busyTimeoutMs?: number
}

export type RustDatabaseBackupResult = DatabaseBackupReport & {
  elapsedMs: number
  workerMode: 'rust-database-backup'
}

export type RustFontResourceBatchEntry = {
  ok: boolean
  count: number
  message: string
}

export type RustFontResourceBatchResult = Record<string, RustFontResourceBatchEntry>

export type RustFontRegistryResult = {
  ok: boolean
  count: number
  failed: number
  elapsedMs: number
  workerMode: 'rust-font-registry-apply' | 'rust-font-registry-delete'
}

export type RustFontNotifyResult = {
  ok: boolean
  elapsedMs: number
  workerMode: 'rust-font-change-notify'
}

export type RustPreviewRenderImageInput = {
  fontPath: string
  preferSystemFont?: boolean
  systemFontFamilyCandidates?: string[]
  text: string
  fontSize: number
  width: number
  height: number
  outputPath: string
}

export type RustPreviewRenderImageResult = {
  ok: boolean
  engine: 'rust-directwrite'
  outputPath: string
  elapsedMs: number
  workerMode: 'rust-preview-render-image'
}

export type RustCoreWorkerRuntimeOptions = {
  appendStartupLog: (message: string) => void
  enabled: boolean
  required: boolean
  onDaemonDomainEvent?: (event: RustCoreDaemonDomainEvent) => void
}
