// Internal Rust stdout/handshake shapes; consume only inside rust-core.
import type { FontTagRevisionMetadata } from '../../shared/types'
import type { FontParseJob } from '../indexing/fontScanWorkers'
import type {
  RustFontScriptHint,
  RustFontStyleHint,
  RustFontFamilyHint,
  RustFontNameHint,
  RustListedDirectory,
  RustMergedIndexPageQueryResult,
  RustMergedIndexIdsQueryResult,
  RustMergedIndexMetricsQueryResult,
  RustMergedIndexMutationProtocol,
  RustMergedIndexRebuildResult,
  RustMergedIndexSyncResult,
  RustSystemInstalledFontsResult,
  RustWatcherPreflightResult,
  RustInstallStatusReadResult,
  RustInstallStatusSaveResult,
  RustInstallStatusCompareResult,
  RustLocalTagsReadResult,
  RustLocalTagsSetResult,
  RustLocalTagsDeleteTagResult,
  RustSharedMetadataApplyResult,
  RustSharedMetadataRemoveTagResult,
  RustSharedMetadataKnownTagsResult,
  RustSharedMetadataOverlayReadResult,
  RustSharedMetadataSignatureResult,
  RustPreviewCacheReadStatusResult,
  RustPreviewCacheApplyResult,
  RustPreviewCacheDeleteResult,
  RustPreviewCacheQueryResult,
  RustPreviewCacheTouchResult,
  RustPreviewCacheBatchResult,
  RustPreviewCacheMaintenanceResult,
  RustPhysicalFolderTreeResult,
  RustFontActivationFilesResult,
  RustDatabaseHealthCheckResult,
  RustDatabaseBackupResult,
  RustFontRegistryResult,
  RustFontNotifyResult,
} from './rustCoreWorkerContracts'

export type RustCoreWorkerHandshake = {
  ok?: boolean
  name?: string
  version?: string
  protocolVersion?: number
  capabilities?: string[]
  message?: string
}

export type RustCoreSchedulerProfilePayload = {
  ok?: boolean
  schedulerVersion?: string
  profiles?: unknown[]
  queuePolicy?: unknown
  workerMode?: string
  message?: string
}

export type RustListFontFilesPayload = {
  ok?: boolean
  root?: string
  truncated?: boolean
  count?: number
  foldersScanned?: number
  files?: Array<{
    path?: string
    size?: number
    modifiedMs?: number
    createdMs?: number
    changedMs?: number
    signatureValid?: boolean
    format?: string
    quickHash?: string
    contentHash?: string
    hashKind?: string
    nameHint?: RustFontNameHint
    scriptHint?: RustFontScriptHint
    styleHint?: RustFontStyleHint
    familyHint?: RustFontFamilyHint
  }>
  directories?: RustListedDirectory[]
  errors?: Array<{ path?: string; message?: string }>
  message?: string
}

export type RustFontParseBatchPayload = {
  ok?: boolean
  results?: Array<Partial<FontParseJob>>
  errors?: Array<{ jobId?: string; path?: string; message?: string }>
  count?: number
  elapsedMs?: number
  workerMode?: string
  message?: string
}

export type RustApplyRootIndexPayload = {
  ok?: boolean
  applied?: boolean
  count?: number
  upserts?: number
  deletes?: number
  message?: string
}

export type RustMergedIndexPageQueryPayload = Partial<RustMergedIndexPageQueryResult> & {
  ok?: boolean
  message?: string
  tagRevision?: FontTagRevisionMetadata
}

export type RustMergedIndexMetricsQueryPayload = Partial<RustMergedIndexMetricsQueryResult> & {
  ok?: boolean
  message?: string
  tagRevision?: FontTagRevisionMetadata
}

export type RustMergedIndexIdsQueryPayload = Partial<RustMergedIndexIdsQueryResult> & {
  ok?: boolean
  message?: string
  tagRevision?: FontTagRevisionMetadata
}

export type RustMergedIndexRebuildPayload = Partial<RustMergedIndexRebuildResult> & {
  ok?: boolean
  message?: string
  indexProtocol?: RustMergedIndexMutationProtocol
}

export type RustMergedIndexSyncPayload = Partial<RustMergedIndexSyncResult> & {
  ok?: boolean
  message?: string
  indexProtocol?: RustMergedIndexMutationProtocol
}

export type RustSystemInstalledFontsPayload = Partial<RustSystemInstalledFontsResult> & {
  ok?: boolean
  message?: string
}

export type RustWatcherPreflightPayload = Partial<RustWatcherPreflightResult> & {
  ok?: boolean
  message?: string
}

export type RustInstallStatusReadPayload = Partial<RustInstallStatusReadResult> & {
  ok?: boolean
  message?: string
}

export type RustInstallStatusSavePayload = Partial<RustInstallStatusSaveResult> & {
  ok?: boolean
  message?: string
}

export type RustInstallStatusComparePayload = Partial<RustInstallStatusCompareResult> & {
  ok?: boolean
  message?: string
}

export type RustLocalTagsReadPayload = Partial<RustLocalTagsReadResult> & {
  ok?: boolean
  message?: string
}

export type RustLocalTagsSetPayload = Partial<RustLocalTagsSetResult> & {
  ok?: boolean
  message?: string
}

export type RustLocalTagsDeleteTagPayload = Partial<RustLocalTagsDeleteTagResult> & {
  ok?: boolean
  message?: string
}

export type RustSharedMetadataApplyPayload = Partial<RustSharedMetadataApplyResult> & {
  ok?: boolean
  message?: string
}

export type RustSharedMetadataRemoveTagPayload = Partial<RustSharedMetadataRemoveTagResult> & {
  ok?: boolean
  message?: string
}

export type RustSharedMetadataKnownTagsPayload = Partial<RustSharedMetadataKnownTagsResult> & {
  ok?: boolean
  message?: string
}

export type RustSharedMetadataOverlayReadPayload = Partial<RustSharedMetadataOverlayReadResult> & {
  ok?: boolean
  message?: string
}

export type RustSharedMetadataSignaturePayload = Partial<RustSharedMetadataSignatureResult> & {
  ok?: boolean
  message?: string
}

export type RustPreviewCacheReadStatusPayload = Partial<RustPreviewCacheReadStatusResult> & {
  ok?: boolean
  message?: string
}

export type RustPreviewCacheApplyPayload = Partial<RustPreviewCacheApplyResult> & {
  ok?: boolean
  message?: string
}

export type RustPreviewCacheDeletePayload = Partial<RustPreviewCacheDeleteResult> & {
  ok?: boolean
  message?: string
}

export type RustPreviewCacheQueryPayload = Partial<RustPreviewCacheQueryResult> & {
  ok?: boolean
  message?: string
}

export type RustPreviewCacheTouchPayload = Partial<RustPreviewCacheTouchResult> & {
  ok?: boolean
  message?: string
}

export type RustPreviewCacheBatchPayload = Partial<RustPreviewCacheBatchResult> & {
  ok?: boolean
  message?: string
}

export type RustPreviewCacheMaintenancePayload = Partial<RustPreviewCacheMaintenanceResult> & {
  ok?: boolean
  message?: string
}

export type RustPhysicalFolderTreePayload = Partial<RustPhysicalFolderTreeResult> & {
  ok?: boolean
  message?: string
}

export type RustFontActivationFilesPayload = Partial<RustFontActivationFilesResult> & {
  ok?: boolean
  message?: string
}

export type RustDatabaseHealthCheckPayload = Partial<RustDatabaseHealthCheckResult> & {
  ok?: boolean
  message?: string
}

export type RustDatabaseBackupPayload = Partial<RustDatabaseBackupResult> & {
  ok?: boolean
  message?: string
}

export type RustFontResourceBatchPayload = {
  ok?: boolean
  message?: string
  count?: number
  failed?: number
  elapsedMs?: number
  results?: Array<{ path?: string; ok?: boolean; count?: number; message?: string }>
}

export type RustFontRegistryPayload = Partial<RustFontRegistryResult> & {
  ok?: boolean
  message?: string
}

export type RustFontNotifyPayload = Partial<RustFontNotifyResult> & {
  ok?: boolean
  message?: string
}

export type RustPreviewRenderImagePayload = {
  ok?: boolean
  engine?: string
  outputPath?: string
  elapsedMs?: number
  message?: string
}
