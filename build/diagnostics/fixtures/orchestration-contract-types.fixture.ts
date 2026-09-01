import {
  createRustCoreWorkerRuntime,
  type RustDatabaseBackupInput,
  type RustDatabaseBackupResult,
  type RustDatabaseHealthCheckInput,
  type RustDatabaseHealthCheckResult,
  type RustFontActivationFilesInput,
  type RustFontActivationFilesResult,
  type RustFontIndexListResult,
  type RustFontNotifyResult,
  type RustFontParseBatchResult,
  type RustFontRegistryResult,
  type RustFontResourceBatchResult,
  type RustInstallStatusCompareInput,
  type RustInstallStatusCompareResult,
  type RustInstallStatusReadResult,
  type RustInstallStatusSaveResult,
  type RustLocalTagsDeleteTagInput,
  type RustLocalTagsDeleteTagResult,
  type RustLocalTagsReadInput,
  type RustLocalTagsReadResult,
  type RustLocalTagsSetInput,
  type RustLocalTagsSetResult,
  type RustMergedIndexIdsQueryInput,
  type RustMergedIndexIdsQueryResult,
  type RustMergedIndexMetricsQueryInput,
  type RustMergedIndexMetricsQueryResult,
  type RustMergedIndexPageQueryInput,
  type RustMergedIndexPageQueryResult,
  type RustMergedIndexRebuildInput,
  type RustMergedIndexRebuildResult,
  type RustMergedIndexSyncInput,
  type RustMergedIndexSyncResult,
  type RustPhysicalFolderTreeInput,
  type RustPhysicalFolderTreeResult,
  type RustPreviewCacheApplyInput,
  type RustPreviewCacheApplyResult,
  type RustPreviewCacheBatchInput,
  type RustPreviewCacheBatchResult,
  type RustPreviewCacheDeleteInput,
  type RustPreviewCacheDeleteResult,
  type RustPreviewCacheMaintenanceInput,
  type RustPreviewCacheMaintenanceResult,
  type RustPreviewCacheQueryInput,
  type RustPreviewCacheQueryResult,
  type RustPreviewCacheReadStatusInput,
  type RustPreviewCacheReadStatusResult,
  type RustPreviewCacheTouchInput,
  type RustPreviewCacheTouchResult,
  type RustPreviewRenderImageInput,
  type RustPreviewRenderImageResult,
  type RustRootIndexApplyChangesInput,
  type RustRootIndexApplyChangesResult,
  type RustSharedMetadataApplyInput,
  type RustSharedMetadataApplyResult,
  type RustSharedMetadataKnownTagsInput,
  type RustSharedMetadataKnownTagsResult,
  type RustSharedMetadataOverlayReadInput,
  type RustSharedMetadataOverlayReadResult,
  type RustSharedMetadataRemoveTagInput,
  type RustSharedMetadataRemoveTagResult,
  type RustSharedMetadataSignatureInput,
  type RustSharedMetadataSignatureResult,
  type RustSystemInstalledFontsInput,
  type RustSystemInstalledFontsResult,
  type RustWatcherPreflightInput,
  type RustWatcherPreflightResult,
} from '../../../src/main/rust-core/rustCoreWorkerRuntime'
import type { FontParseJob } from '../../../src/main/indexing/fontScanWorkers'
import type { InstallStatusReadWorkerGroup, InstallStatusSaveWorkerGroup } from '../../../src/main/install/status/installStatusTypes'

type Runtime = ReturnType<typeof createRustCoreWorkerRuntime>

type ExpectedRustCommandFacade = {
  runRustFontIndexListWorker: (folders: string[], extensions: string[], progress?: (payload: { files: number; foldersScanned: number }) => void, signal?: AbortSignal) => Promise<RustFontIndexListResult | null>
  runRustFontParseBatch: (jobs: FontParseJob[], signal?: AbortSignal) => Promise<RustFontParseBatchResult | null>
  runRustRootIndexApplyChanges: (input: RustRootIndexApplyChangesInput) => Promise<RustRootIndexApplyChangesResult | null>
  runRustMergedIndexPageQuery: (input: RustMergedIndexPageQueryInput) => Promise<RustMergedIndexPageQueryResult | null>
  runRustMergedIndexIdsQuery: (input: RustMergedIndexIdsQueryInput) => Promise<RustMergedIndexIdsQueryResult | null>
  runRustMergedIndexMetricsQuery: (input: RustMergedIndexMetricsQueryInput) => Promise<RustMergedIndexMetricsQueryResult | null>
  runRustMergedIndexRebuild: (input: RustMergedIndexRebuildInput) => Promise<RustMergedIndexRebuildResult | null>
  runRustMergedIndexSync: (input: RustMergedIndexSyncInput) => Promise<RustMergedIndexSyncResult | null>
  runRustWatcherPreflight: (input: RustWatcherPreflightInput) => Promise<RustWatcherPreflightResult | null>
  runRustInstallStatusRead: (groups: InstallStatusReadWorkerGroup[]) => Promise<RustInstallStatusReadResult | null>
  runRustInstallStatusSave: (groups: InstallStatusSaveWorkerGroup[]) => Promise<RustInstallStatusSaveResult | null>
  runRustInstallStatusCompare: (input: RustInstallStatusCompareInput) => Promise<RustInstallStatusCompareResult | null>
  runRustLocalTagsRead: (input: RustLocalTagsReadInput) => Promise<RustLocalTagsReadResult | null>
  runRustLocalTagsSet: (input: RustLocalTagsSetInput) => Promise<RustLocalTagsSetResult | null>
  runRustLocalTagsDeleteTag: (input: RustLocalTagsDeleteTagInput) => Promise<RustLocalTagsDeleteTagResult | null>
  runRustSharedMetadataApply: (input: RustSharedMetadataApplyInput) => Promise<RustSharedMetadataApplyResult | null>
  runRustSharedMetadataRemoveTag: (input: RustSharedMetadataRemoveTagInput) => Promise<RustSharedMetadataRemoveTagResult | null>
  runRustSharedMetadataKnownTags: (input: RustSharedMetadataKnownTagsInput) => Promise<RustSharedMetadataKnownTagsResult | null>
  runRustSharedMetadataOverlayRead: (input: RustSharedMetadataOverlayReadInput) => Promise<RustSharedMetadataOverlayReadResult | null>
  runRustSharedMetadataSignature: (input: RustSharedMetadataSignatureInput) => Promise<RustSharedMetadataSignatureResult | null>
  runRustPreviewCacheReadStatus: (input: RustPreviewCacheReadStatusInput) => Promise<RustPreviewCacheReadStatusResult | null>
  runRustPreviewCacheApply: (input: RustPreviewCacheApplyInput) => Promise<RustPreviewCacheApplyResult | null>
  runRustPreviewCacheDelete: (input: RustPreviewCacheDeleteInput) => Promise<RustPreviewCacheDeleteResult | null>
  runRustPreviewCacheQuery: (input: RustPreviewCacheQueryInput) => Promise<RustPreviewCacheQueryResult | null>
  runRustPreviewCacheTouch: (input: RustPreviewCacheTouchInput) => Promise<RustPreviewCacheTouchResult | null>
  runRustPreviewCacheBatch: (input: RustPreviewCacheBatchInput) => Promise<RustPreviewCacheBatchResult | null>
  runRustPreviewCacheMaintenance: (input: RustPreviewCacheMaintenanceInput) => Promise<RustPreviewCacheMaintenanceResult | null>
  runRustDatabaseHealthCheck: (input: RustDatabaseHealthCheckInput) => Promise<RustDatabaseHealthCheckResult | null>
  runRustDatabaseBackup: (input: RustDatabaseBackupInput) => Promise<RustDatabaseBackupResult | null>
  runRustFontResourceAdd: (paths: string[], options?: { notify?: boolean; reason?: string; strong?: boolean }) => Promise<RustFontResourceBatchResult | null>
  runRustFontResourceRemove: (paths: string[], options?: { notify?: boolean; reason?: string; strong?: boolean }) => Promise<RustFontResourceBatchResult | null>
  runRustFontRegistryApply: (records: Array<{ name: string; path: string }>) => Promise<RustFontRegistryResult | null>
  runRustFontRegistryDelete: (names: string[]) => Promise<RustFontRegistryResult | null>
  runRustFontChangeNotify: (input?: { strong?: boolean; reason?: string }) => Promise<RustFontNotifyResult | null>
  runRustPhysicalFolderTree: (input: RustPhysicalFolderTreeInput) => Promise<RustPhysicalFolderTreeResult | null>
  runRustFontActivationFiles: (input: RustFontActivationFilesInput) => Promise<RustFontActivationFilesResult | null>
  runRustPreviewRenderImage: (input: RustPreviewRenderImageInput) => Promise<RustPreviewRenderImageResult | null>
  runRustSystemInstalledFonts: (input: RustSystemInstalledFontsInput) => Promise<RustSystemInstalledFontsResult | null>
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
  ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false
  : false
type Assert<T extends true> = T
type _RustCommandFacadeAssignable = Assert<Equal<Pick<Runtime, keyof ExpectedRustCommandFacade>, ExpectedRustCommandFacade>>

export type AppRootViewTargetContract = {
  topbar: unknown
  sidebar: unknown
  content: unknown
  detail: unknown
  overlays: unknown
  developer: unknown
}

type _AppRootViewTargetGroups = Assert<Equal<keyof AppRootViewTargetContract, 'topbar' | 'sidebar' | 'content' | 'detail' | 'overlays' | 'developer'>>
