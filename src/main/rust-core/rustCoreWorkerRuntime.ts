import { createRustMaintenanceClientRuntime } from './clients/rustMaintenanceClientRuntime'
import { createRustCoreWorkerTransportRuntime, parseJsonLine, hasCapability } from './rustCoreWorkerTransportRuntime'
import type { CachedFontStatLike } from '../fonts/fontRuntime'
import type { SystemInstalledFont } from '../../shared/types'
import type { InstallStatusReadWorkerGroup, InstallStatusSaveWorkerGroup } from '../install/status/installStatusTypes'
import type { PreviewCacheIndexStatus } from '../preview/previewCacheRuntime'
import type { FontParseJob } from '../indexing/fontScanWorkers'

import { isRustCoreDaemonSubmittedError } from './rustCoreDaemonRuntime'
import { rethrowRustCoreDaemonSubmittedJob, markRustCoreDaemonSubmittedError } from './rustCoreDaemonWriteBoundaryRuntime'
import { rustStateFallbackFailureLogSuffix } from './rustStateFallbackFailureProtocolRuntime'
import { nodeFontkitScanFallbackFailureLogSuffix } from './nodeFontkitScanFallbackCompatibilityRuntime'

import type {
  RustFontScriptHint,
  RustFontStyleHint,
  RustFontFamilyHint,
  RustFontNameHint,
  RustListedFontFile,
  RustListedDirectory,
  RustFontIndexListResult,
  RustFontParseBatchResult,
  RustRootIndexApplyChangesInput,
  RustRootIndexApplyChangesResult,
  RustMergedIndexPageQueryInput,
  RustMergedIndexPageQueryResult,
  RustMergedIndexIdsQueryInput,
  RustMergedIndexIdsQueryResult,
  RustMergedIndexMetricsQueryInput,
  RustMergedIndexMetricsQueryResult,
  RustMergedIndexRebuildInput,
  RustMergedIndexRebuildResult,
  RustMergedIndexSyncInput,
  RustMergedIndexSyncResult,
  RustSystemInstalledFontsInput,
  RustSystemInstalledFontsResult,
  RustWatcherPreflightInput,
  RustWatcherPreflightResult,
  RustInstallStatusReadResult,
  RustInstallStatusSaveResult,
  RustInstallStatusCompareInput,
  RustInstallStatusCompareResult,
  RustLocalTagsReadInput,
  RustLocalTagsReadResult,
  RustLocalTagsSetInput,
  RustLocalTagsDeleteTagInput,
  RustLocalTagsMutationStateSignal,
  RustLocalTagsSetResult,
  RustLocalTagsDeleteTagResult,
  RustSharedMetadataApplyInput,
  RustSharedMetadataMutationStateSignal,
  RustTagMutationProtocolResult,
  RustSharedMetadataApplyResult,
  RustSharedMetadataRemoveTagInput,
  RustSharedMetadataRemoveTagResult,
  RustSharedMetadataSignatureInput,
  RustSharedMetadataKnownTagsInput,
  RustSharedMetadataKnownTagsResult,
  RustSharedMetadataOverlayReadInput,
  RustSharedMetadataOverlayReadResult,
  RustSharedMetadataSignatureResult,
  RustPreviewCacheReadStatusInput,
  RustPreviewCacheReadStatusResult,
  RustPreviewCacheApplyInput,
  RustPreviewCacheApplyResult,
  RustPreviewCacheDeleteInput,
  RustPreviewCacheDeleteResult,
  RustPreviewCacheQueryInput,
  RustPreviewCacheQueryResult,
  RustPreviewCacheTouchInput,
  RustPreviewCacheTouchResult,
  RustPreviewCacheBatchInput,
  RustPreviewCacheBatchResult,
  RustPreviewCacheMaintenanceInput,
  RustPreviewCacheMaintenanceResult,
  RustPhysicalFolderTreeInput,
  RustPhysicalFolderTreeResult,
  RustFontActivationFilesInput,
  RustFontActivationFilesResult,
  RustFontResourceBatchResult,
  RustFontRegistryResult,
  RustFontNotifyResult,
  RustPreviewRenderImageInput,
  RustPreviewRenderImageResult,
  RustCoreWorkerRuntimeOptions,
} from './rustCoreWorkerContracts'
import type {
  RustListFontFilesPayload,
  RustFontParseBatchPayload,
  RustApplyRootIndexPayload,
  RustMergedIndexPageQueryPayload,
  RustMergedIndexMetricsQueryPayload,
  RustMergedIndexIdsQueryPayload,
  RustMergedIndexRebuildPayload,
  RustMergedIndexSyncPayload,
  RustSystemInstalledFontsPayload,
  RustWatcherPreflightPayload,
  RustInstallStatusReadPayload,
  RustInstallStatusSavePayload,
  RustInstallStatusComparePayload,
  RustLocalTagsReadPayload,
  RustLocalTagsSetPayload,
  RustLocalTagsDeleteTagPayload,
  RustSharedMetadataApplyPayload,
  RustSharedMetadataRemoveTagPayload,
  RustSharedMetadataKnownTagsPayload,
  RustSharedMetadataOverlayReadPayload,
  RustSharedMetadataSignaturePayload,
  RustPreviewCacheReadStatusPayload,
  RustPreviewCacheApplyPayload,
  RustPreviewCacheDeletePayload,
  RustPreviewCacheQueryPayload,
  RustPreviewCacheTouchPayload,
  RustPreviewCacheBatchPayload,
  RustPreviewCacheMaintenancePayload,
  RustPhysicalFolderTreePayload,
  RustFontActivationFilesPayload,
  RustFontResourceBatchPayload,
  RustFontRegistryPayload,
  RustFontNotifyPayload,
  RustPreviewRenderImagePayload,
} from './rustCoreWorkerPayloadTypes'

// Preserve the existing public type import path without loading another runtime.
export type {
  RustCoreWorkerStatus,
  RustFontScriptHint,
  RustFontStyleHint,
  RustFontFamilyHint,
  RustFontNameHint,
  RustListedFontFile,
  RustListedDirectory,
  RustFontIndexListResult,
  RustFontParseBatchResult,
  RustRootIndexApplyChangesInput,
  RustRootIndexApplyChangesResult,
  RustMergedIndexPageQueryInput,
  RustMergedIndexPageQueryResult,
  RustMergedIndexIdsQueryInput,
  RustMergedIndexIdsQueryResult,
  RustMergedIndexMetricsQueryInput,
  RustMergedIndexMetricsQueryResult,
  RustMergedIndexMutationProtocol,
  RustMergedIndexRebuildSource,
  RustMergedIndexRebuildInput,
  RustMergedIndexRebuildResult,
  RustMergedIndexSyncInput,
  RustMergedIndexSyncResult,
  RustSystemInstalledFontsInput,
  RustSystemInstalledFontsResult,
  RustWatcherPreflightInput,
  RustWatcherPreflightResult,
  RustInstallStatusReadResult,
  RustInstallStatusSaveResult,
  RustInstallStatusCompareInput,
  RustInstallStatusCompareResult,
  RustLocalTagsSetRow,
  RustLocalTagsReadRow,
  RustLocalTagsReadInput,
  RustLocalTagsReadResult,
  RustLocalTagsSetInput,
  RustLocalTagsDeleteTagInput,
  RustLocalTagsMutationStateSignal,
  RustLocalTagsSetResult,
  RustLocalTagsDeleteTagResult,
  RustSharedMetadataApplyRow,
  RustSharedMetadataApplyInput,
  RustSharedMetadataMutationStateSignal,
  RustTagMutationProtocolResult,
  RustSharedMetadataApplyResult,
  RustSharedMetadataRemoveTagInput,
  RustSharedMetadataRemoveTagResult,
  RustSharedMetadataSignatureInput,
  RustSharedMetadataKnownTagsInput,
  RustSharedMetadataKnownTagsResult,
  RustSharedMetadataOverlayReadEntry,
  RustSharedMetadataOverlayReadInput,
  RustSharedMetadataOverlayMatchedEntry,
  RustSharedMetadataOverlayReadResult,
  RustSharedMetadataSignatureResult,
  RustPreviewCacheReadStatusInput,
  RustPreviewCacheReadStatusResult,
  RustPreviewCacheApplyInput,
  RustPreviewCacheApplyResult,
  RustPreviewCacheDeleteInput,
  RustPreviewCacheDeleteResult,
  RustPreviewCacheQueryRow,
  RustPreviewCacheQueryInput,
  RustPreviewCacheQueryMatch,
  RustPreviewCacheQueryResult,
  RustPreviewCacheTouchInput,
  RustPreviewCacheTouchResult,
  RustPreviewCacheBatchInput,
  RustPreviewCacheBatchMatch,
  RustPreviewCacheBatchResult,
  RustPreviewCacheMaintenanceInput,
  RustPreviewCacheMaintenanceResult,
  RustPhysicalFolderTreeInput,
  RustPhysicalFolderTreeResult,
  RustFontActivationFileCopy,
  RustFontActivationFilesInput,
  RustFontActivationFilesResult,
  RustDatabaseMaintenanceFileItem,
  RustDatabaseHealthCheckInput,
  RustDatabaseHealthCheckResult,
  RustDatabaseBackupInput,
  RustDatabaseBackupResult,
  RustFontResourceBatchEntry,
  RustFontResourceBatchResult,
  RustFontRegistryResult,
  RustFontNotifyResult,
  RustPreviewRenderImageInput,
  RustPreviewRenderImageResult,
  RustCoreWorkerRuntimeOptions,
} from './rustCoreWorkerContracts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cleanRustStringArray(value: unknown): string[] {
  return Array.from(new Set((Array.isArray(value) ? value : [])
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)))
}

function normalizeRustTagMutationProtocolResult(
  payload: { mutationProtocol?: unknown; stateSignal?: unknown; timings?: unknown },
  fallback: {
    command: string
    domain: 'localTags' | 'sharedMetadata'
    mutationKind: string
    changedIds?: unknown
    knownTags?: unknown
    signature?: unknown
    workerMode: string
  },
): RustTagMutationProtocolResult {
  const protocol = isRecord(payload.mutationProtocol) ? payload.mutationProtocol : {}
  const protocolChangedIds = cleanRustStringArray(protocol.changedIds)
  const fallbackChangedIds = cleanRustStringArray(fallback.changedIds)
  const protocolKnownTags = cleanRustStringArray(protocol.knownTags)
  const fallbackKnownTags = cleanRustStringArray(fallback.knownTags)
  const stateSignal = isRecord(protocol.stateSignal)
    ? protocol.stateSignal
    : (isRecord(payload.stateSignal) ? payload.stateSignal : undefined)
  const timings = isRecord(protocol.timings)
    ? protocol.timings as Record<string, number>
    : (isRecord(payload.timings) ? payload.timings as Record<string, number> : undefined)
  return {
    ok: typeof protocol.ok === 'boolean' ? protocol.ok : true,
    message: typeof protocol.message === 'string' ? protocol.message : undefined,
    command: typeof protocol.command === 'string' && protocol.command ? protocol.command : fallback.command,
    domain: typeof protocol.domain === 'string' && protocol.domain ? protocol.domain : fallback.domain,
    mutationKind: typeof protocol.mutationKind === 'string' && protocol.mutationKind ? protocol.mutationKind : fallback.mutationKind,
    source: typeof protocol.source === 'string' && protocol.source ? protocol.source : 'rust-worker',
    changedIds: protocolChangedIds.length ? protocolChangedIds : fallbackChangedIds,
    updatedAt: typeof protocol.updatedAt === 'string' ? protocol.updatedAt : undefined,
    dbPath: typeof protocol.dbPath === 'string' ? protocol.dbPath : undefined,
    rootPath: typeof protocol.rootPath === 'string' ? protocol.rootPath : undefined,
    knownTags: protocolKnownTags.length ? protocolKnownTags : fallbackKnownTags,
    signature: typeof protocol.signature === 'string' && protocol.signature ? protocol.signature : (typeof fallback.signature === 'string' ? fallback.signature : undefined),
    cacheInvalidated: typeof protocol.cacheInvalidated === 'boolean' ? protocol.cacheInvalidated : undefined,
    mergedIndexDirty: typeof protocol.mergedIndexDirty === 'boolean' ? protocol.mergedIndexDirty : undefined,
    pageQueryDirty: typeof protocol.pageQueryDirty === 'boolean' ? protocol.pageQueryDirty : undefined,
    metricsDirty: typeof protocol.metricsDirty === 'boolean' ? protocol.metricsDirty : undefined,
    stateSignal,
    timings,
    workerMode: typeof protocol.workerMode === 'string' && protocol.workerMode ? protocol.workerMode : fallback.workerMode,
  }
}

function normalizePreviewCacheStatusPayload(value: unknown): PreviewCacheIndexStatus | null {
  return value === 'ok' || value === 'missing' || value === 'failed' || value === 'pending' || value === 'generating' || value === 'stale' ? value : null
}

function rustNameProbeEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_NAME_PROBE || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

function rustScriptProbeEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_SCRIPT_PROBE || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

function rustStyleProbeEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_STYLE_PROBE || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

function rustFamilyProbeEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_FAMILY_PROBE || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

function rustFullHashEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_FULL_HASH || '0').trim().toLowerCase()
  return mode === '1' || mode === 'true' || mode === 'on'
}

function normalizeNameHint(input: unknown): RustFontNameHint | undefined {
  if (!input || typeof input !== 'object') return undefined
  const source = input as Record<string, unknown>
  const result: RustFontNameHint = {}
  for (const key of ['familyName', 'subfamilyName', 'fullName', 'postscriptName', 'preferredFamily', 'preferredSubfamily', 'displayFamily', 'displaySubfamily', 'version', 'manufacturer'] as const) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) result[key] = value.trim()
  }
  if (typeof source.recordCount === 'number') result.recordCount = source.recordCount
  if (typeof source.sourceIndex === 'number') result.sourceIndex = source.sourceIndex
  return Object.keys(result).length ? result : undefined
}

function normalizeScriptHint(input: unknown): RustFontScriptHint | undefined {
  if (!input || typeof input !== 'object') return undefined
  const source = input as Record<string, unknown>
  const scripts = Array.isArray(source.scripts)
    ? source.scripts.filter((value): value is string => typeof value === 'string' && Boolean(value.trim())).map((value) => value.trim())
    : []
  if (!scripts.length) return undefined
  const result: RustFontScriptHint = { scripts: Array.from(new Set(scripts)) }
  if (typeof source.rangeCount === 'number') result.rangeCount = source.rangeCount
  if (typeof source.sourceIndex === 'number') result.sourceIndex = source.sourceIndex
  return result
}

function normalizeStyleHint(input: unknown): RustFontStyleHint | undefined {
  if (!input || typeof input !== 'object') return undefined
  const source = input as Record<string, unknown>
  const result: RustFontStyleHint = {}
  for (const [sourceKey, targetKey] of [
    ['weightClass', 'weightClass'],
    ['widthClass', 'widthClass'],
    ['unitsPerEm', 'unitsPerEm'],
    ['glyphCount', 'glyphCount'],
    ['sourceIndex', 'sourceIndex'],
  ] as const) {
    const value = source[sourceKey]
    if (typeof value === 'number' && Number.isFinite(value)) result[targetKey] = value
  }
  if (typeof source.italic === 'boolean') result.italic = source.italic
  if (typeof source.bold === 'boolean') result.bold = source.bold
  if (typeof source.monospaced === 'boolean') result.monospaced = source.monospaced
  return Object.keys(result).length ? result : undefined
}


function normalizeFamilyHint(input: unknown): RustFontFamilyHint | undefined {
  if (!input || typeof input !== 'object') return undefined
  const source = input as Record<string, unknown>
  const result: RustFontFamilyHint = {}
  for (const key of ['familyName', 'styleName', 'familyKey', 'styleKey'] as const) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) result[key] = value.trim()
  }
  for (const key of ['weightClass', 'widthClass', 'sourceIndex'] as const) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) result[key] = value
  }
  if (typeof source.italic === 'boolean') result.italic = source.italic
  if (typeof source.bold === 'boolean') result.bold = source.bold
  if (typeof source.monospaced === 'boolean') result.monospaced = source.monospaced
  return Object.keys(result).length ? result : undefined
}

function statFromRustFile(item: NonNullable<RustListFontFilesPayload['files']>[number]): CachedFontStatLike {
  const modifiedMs = Number(item.modifiedMs || 0)
  const createdMs = Number(item.createdMs || item.changedMs || modifiedMs || 0)
  return {
    size: Number(item.size || 0),
    mtimeMs: modifiedMs,
    birthtimeMs: createdMs,
    ctimeMs: Number(item.changedMs || createdMs || modifiedMs || 0),
  }
}

function normalizeRustParseBatchJob(input: Partial<FontParseJob>): FontParseJob | null {
  if (!input || typeof input !== 'object') return null
  const jobId = typeof input.jobId === 'string' ? input.jobId : ''
  const rootPath = typeof input.rootPath === 'string' ? input.rootPath : ''
  const filePath = typeof input.filePath === 'string' ? input.filePath : ''
  const cacheKey = typeof input.cacheKey === 'string' ? input.cacheKey : ''
  const signature = typeof input.signature === 'string' ? input.signature : ''
  if (!jobId || !rootPath || !filePath || !cacheKey || !signature) return null
  return {
    jobId,
    rootPath,
    filePath,
    cacheKey,
    signature,
    fileSize: Number(input.fileSize || 0),
    modifiedAt: Number(input.modifiedAt || 0),
    createdAt: Number(input.createdAt || 0),
    signatureValid: typeof input.signatureValid === 'boolean' ? input.signatureValid : undefined,
    formatHint: typeof input.formatHint === 'string' ? input.formatHint : undefined,
    quickHash: typeof input.quickHash === 'string' ? input.quickHash : undefined,
    contentHash: typeof input.contentHash === 'string' ? input.contentHash : undefined,
    hashKind: typeof input.hashKind === 'string' ? input.hashKind : undefined,
    nameHint: normalizeNameHint(input.nameHint),
    scriptHint: normalizeScriptHint(input.scriptHint),
    styleHint: normalizeStyleHint(input.styleHint),
    familyHint: normalizeFamilyHint(input.familyHint),
  }
}

export function createRustCoreWorkerRuntime(options: RustCoreWorkerRuntimeOptions) {
  const transport = createRustCoreWorkerTransportRuntime(options)
  const {
    diagnoseRustCoreWorker,
    invalidateRustCoreSchedulerCaches, cancelRustCoreSchedulerScopes,
    noteRustCoreSchedulerInteractiveActivity, runRustCoreScheduledCommand,
    appendPreviewCacheFailureLog, createTemporaryJsonFile,
  } = transport
  const { runRustDatabaseHealthCheck, runRustDatabaseBackup } = createRustMaintenanceClientRuntime({
    diagnoseRustCoreWorker, runRustCoreScheduledCommand, createTemporaryJsonFile,
    appendStartupLog: options.appendStartupLog,
  })


  async function runRustFontIndexListWorker(
    folders: string[],
    extensions: string[],
    progress?: (payload: { files: number; foldersScanned: number }) => void,
    signal?: AbortSignal,
  ): Promise<RustFontIndexListResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'list-font-files')) return null

    const startedAt = Date.now()
    const files: RustListedFontFile[] = []
    const directories: RustListedDirectory[] = []
    const errors: Array<{ path: string; message: string }> = []
    let foldersScanned = 0
    let truncated = false

    for (const rootPath of folders) {
      if (signal?.aborted) throw new Error('Rust listing cancelled')
      const outputFile = createTemporaryJsonFile(`hfm-rust-list`)
      const outputPath = outputFile.path
      try {
        const args = [
          '--list-font-files',
          '--root',
          rootPath,
          '--extensions',
          extensions.map((value) => value.replace(/^\./, '').toLowerCase()).join(','),
          '--max',
          String(Math.max(1, Number(process.env.HFM_RUST_SCAN_LISTING_MAX || 300000) || 300000)),
          '--output',
          outputPath,
        ]
        if (rustNameProbeEnabled() && hasCapability(status, 'font-name-table-probe')) args.push('--probe-names')
        if (rustScriptProbeEnabled() && hasCapability(status, 'font-script-table-probe')) args.push('--probe-scripts')
        if (rustStyleProbeEnabled() && hasCapability(status, 'font-style-table-probe')) args.push('--probe-style')
        if (rustFamilyProbeEnabled() && hasCapability(status, 'font-family-hint-probe')) args.push('--probe-family')
        if (rustFullHashEnabled() && hasCapability(status, 'font-full-fingerprint')) args.push('--full-hash')
        const { stdout } = await runRustCoreScheduledCommand(status.path, args, {
          timeout: Math.max(5000, Number(process.env.HFM_RUST_SCAN_LISTING_TIMEOUT_MS || 10 * 60 * 1000) || 10 * 60 * 1000),
          windowsHide: true,
          maxBuffer: 256 * 1024,
          signal,
        })
        const written = parseJsonLine<{ ok?: boolean; message?: string }>(stdout)
        if (!written.ok) throw new Error(written.message || 'rust listing output write failed')
        const raw = await outputFile.readText()
        const payload = JSON.parse(raw) as RustListFontFilesPayload
        if (!payload.ok) throw new Error(payload.message || 'rust listing returned ok=false')

        for (const item of payload.files || []) {
          if (!item.path) continue
          files.push({ file: item.path, rootPath, stat: statFromRustFile(item), signatureValid: item.signatureValid, format: item.format || undefined, quickHash: item.quickHash || undefined, contentHash: item.contentHash || item.quickHash || undefined, hashKind: item.hashKind || (item.contentHash ? 'quick-fnv1a64' : undefined), nameHint: normalizeNameHint(item.nameHint), scriptHint: normalizeScriptHint(item.scriptHint), styleHint: normalizeStyleHint(item.styleHint), familyHint: normalizeFamilyHint(item.familyHint) })
        }
        directories.push(...((payload.directories || []).filter((item) => item?.path) as RustListedDirectory[]))
        for (const error of payload.errors || []) {
          if (!error?.path && !error?.message) continue
          errors.push({ path: error.path || rootPath, message: error.message || 'Rust listing error' })
        }
        foldersScanned += Number(payload.foldersScanned || payload.directories?.length || 0)
        truncated = truncated || Boolean(payload.truncated)
        progress?.({ files: files.length, foldersScanned })
      } finally {
        await outputFile.dispose()
      }
    }

    const durationMs = Date.now() - startedAt
    options.appendStartupLog(`rust scan listing finished: roots=${folders.length}, files=${files.length}, valid=${files.filter((item) => item.signatureValid !== false).length}, invalid=${files.filter((item) => item.signatureValid === false).length}, quickHash=${files.filter((item) => item.quickHash).length}, contentHash=${files.filter((item) => item.contentHash).length}, fullHash=${files.filter((item) => item.hashKind === 'full-fnv1a64').length}, nameHints=${files.filter((item) => item.nameHint).length}, scriptHints=${files.filter((item) => item.scriptHint).length}, styleHints=${files.filter((item) => item.styleHint).length}, familyHints=${files.filter((item) => item.familyHint).length}, folders=${foldersScanned}, errors=${errors.length}, truncated=${truncated}, durationMs=${durationMs}`)
    return { files, directories, errors, foldersScanned, truncated, durationMs }
  }


  async function runRustFontParseBatch(jobs: FontParseJob[], signal?: AbortSignal): Promise<RustFontParseBatchResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'font-parse-batch')) return null
    if (signal?.aborted) throw new Error('Rust parse batch cancelled')

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-parse-batch`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({
        jobs,
        fullHash: rustFullHashEnabled(),
      })
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--font-parse-batch',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_PARSE_BATCH_TIMEOUT_MS || 5 * 60 * 1000) || 5 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        signal,
      })
      if (signal?.aborted) throw new Error('Rust parse batch cancelled')

      const payload = parseJsonLine<RustFontParseBatchPayload>(stdout)
      if (!payload.ok || !Array.isArray(payload.results)) throw new Error(payload.message || 'rust font parse batch returned ok=false')
      const results = payload.results
        .map((item) => normalizeRustParseBatchJob(item))
        .filter((item): item is FontParseJob => Boolean(item))
      const result: RustFontParseBatchResult = {
        results,
        errors: Array.isArray(payload.errors) ? payload.errors : [],
        count: Number(payload.count ?? results.length),
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-font-parse-batch',
      }
      options.appendStartupLog(`rust font parse batch finished: jobs=${jobs.length}, results=${result.results.length}, errors=${result.errors.length}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      options.appendStartupLog(`rust font parse batch failed: ${error instanceof Error ? error.message : String(error)}; ${nodeFontkitScanFallbackFailureLogSuffix()}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }


  async function runRustRootIndexApplyChanges(input: RustRootIndexApplyChangesInput): Promise<RustRootIndexApplyChangesResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'root-index-sqlite-apply-changes')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-root-index`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({
        upserts: input.upserts.map(([relativePath, entry]) => ({ relativePath, entry })),
        deletes: input.deletes,
      })

      const commandOutput = await runRustCoreScheduledCommand(status.path, [
        '--root-index-apply-changes',
        '--db', input.dbPath,
        '--root', input.rootPath,
        '--storage', input.storage,
        '--input', inputPath,
        '--schema-version', String(input.schemaVersion),
        '--cache-version', String(input.cacheVersion),
        '--script-detection-version', String(input.scriptDetectionVersion),
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_ROOT_INDEX_WRITE_TIMEOUT_MS || 10 * 60 * 1000) || 10 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 256 * 1024,
      })

      const payload = parseJsonLine<RustApplyRootIndexPayload>(commandOutput.stdout)
      if (!payload.ok || !payload.applied) {
        const error = new Error(payload.message || 'rust root index apply returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--root-index-apply-changes') : error
      }
      const result = {
        applied: true,
        count: Number(payload.count || 0),
        upserts: Number(payload.upserts || 0),
        deletes: Number(payload.deletes || 0),
        durationMs: Date.now() - startedAt,
      }
      options.appendStartupLog(`rust root index apply finished: db=${input.dbPath}, root=${input.rootPath}, upserts=${result.upserts}, deletes=${result.deletes}, count=${result.count}, durationMs=${result.durationMs}`)
      return result
    } catch (error) {
      if (isRustCoreDaemonSubmittedError(error)) {
        options.appendStartupLog(`rust root index apply failed after daemon submit: ${error.message}; Node fallback blocked`)
        throw error
      }
      options.appendStartupLog(`rust root index apply failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--root-index-apply-changes')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }


  async function runRustMergedIndexPageQuery(input: RustMergedIndexPageQueryInput): Promise<RustMergedIndexPageQueryResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'merged-index-page-query')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-merged-page`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--merged-index-query-page',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_MERGED_PAGE_QUERY_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustMergedIndexPageQueryPayload>(stdout)
      if (!payload.ok || !Array.isArray(payload.items)) throw new Error(payload.message || 'rust merged index page query returned ok=false')
      const result: RustMergedIndexPageQueryResult = {
        queryKey: String(payload.queryKey || input.queryKey),
        items: payload.items,
        total: Number(payload.total || 0),
        offset: Number(payload.offset ?? input.offset),
        limit: Number(payload.limit ?? input.limit),
        truncated: Boolean(payload.truncated),
        engine: payload.engine === 'like' ? 'like' : 'sql',
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-merged-index-page',
        tagRevision: payload.tagRevision,
        timings: payload.timings || {},
      }
      options.appendStartupLog(`rust merged index page query finished: roots=${input.roots.length}, total=${result.total}, items=${result.items.length}, offset=${result.offset}, limit=${result.limit}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms, timings=${JSON.stringify(result.timings || {})}`)
      return result
    } finally {
      await inputFile.dispose()
    }
  }



  async function runRustMergedIndexIdsQuery(input: RustMergedIndexIdsQueryInput): Promise<RustMergedIndexIdsQueryResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'merged-index-ids-query')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-merged-ids`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--merged-index-query-ids',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_MERGED_IDS_QUERY_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustMergedIndexIdsQueryPayload>(stdout)
      if (!payload.ok || !Array.isArray(payload.ids)) throw new Error(payload.message || 'rust merged index ids query returned ok=false')
      const result: RustMergedIndexIdsQueryResult = {
        queryKey: String(payload.queryKey || input.queryKey),
        ids: payload.ids.filter((id): id is string => typeof id === 'string' && Boolean(id)),
        total: Number(payload.total || 0),
        limit: Number(payload.limit ?? input.limit),
        truncated: Boolean(payload.truncated),
        engine: payload.engine === 'like' ? 'like' : 'sql',
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-merged-index-ids',
        tagRevision: payload.tagRevision,
        timings: payload.timings || {},
      }
      options.appendStartupLog(`rust merged index ids query finished: roots=${input.roots.length}, ids=${result.ids.length}, truncated=${result.truncated}, limit=${result.limit}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms, timings=${JSON.stringify(result.timings || {})}`)
      return result
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustMergedIndexMetricsQuery(input: RustMergedIndexMetricsQueryInput): Promise<RustMergedIndexMetricsQueryResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'merged-index-metrics-query')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-merged-metrics`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--merged-index-query-metrics',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_MERGED_METRICS_QUERY_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustMergedIndexMetricsQueryPayload>(stdout)
      if (!payload.ok) throw new Error(payload.message || 'rust merged index metrics query returned ok=false')
      const result: RustMergedIndexMetricsQueryResult = {
        total: Number(payload.total || 0),
        favoriteCount: Number(payload.favoriteCount || 0),
        installedCount: Number(payload.installedCount || 0),
        notInstalledCount: Number(payload.notInstalledCount || 0),
        installStatusKnownCount: Number(payload.installStatusKnownCount || 0),
        installStatusMissingCount: Number(payload.installStatusMissingCount || 0),
        installStatusReady: payload.installStatusReady !== false,
        activeCount: Number(payload.activeCount || 0),
        systemDefaultCount: Number(payload.systemDefaultCount || 0),
        formatCounts: payload.formatCounts || { ttf: 0, otf: 0, ttc: 0, otc: 0, unknown: 0 },
        categoryCounts: payload.categoryCounts || { all: 0, serif: 0, slabSerif: 0, sansSerif: 0, script: 0, monospace: 0, handwriting: 0, hei: 0, art: 0 },
        scriptCounts: payload.scriptCounts || {},
        collectionCounts: payload.collectionCounts || {},
        tagCounts: payload.tagCounts || {},
        localTagCounts: payload.localTagCounts || {},
        sharedTagCounts: payload.sharedTagCounts || {},
        folderCounts: payload.folderCounts || {},
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-merged-index-metrics',
        tagRevision: payload.tagRevision,
        timings: payload.timings || {},
      }
      const nonZeroFolderCounts = Object.values(result.folderCounts || {}).filter((value) => Number(value || 0) > 0).length
      const folderCountTotal = Object.values(result.folderCounts || {}).reduce((sum, value) => sum + Number(value || 0), 0)
      options.appendStartupLog(`rust merged index metrics query finished: roots=${input.roots.length}, total=${result.total}, installed=${result.installedCount}, notInstalled=${result.notInstalledCount}, folderKeys=${Object.keys(result.folderCounts || {}).length}, folderNonZero=${nonZeroFolderCounts}, folderCountTotal=${folderCountTotal}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms, timings=${JSON.stringify(result.timings || {})}`)
      return result
    } finally {
      await inputFile.dispose()
    }
  }


  async function runRustMergedIndexRebuild(input: RustMergedIndexRebuildInput): Promise<RustMergedIndexRebuildResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'merged-index-rebuild')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-merged-rebuild`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, [
        '--merged-index-rebuild',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_MERGED_REBUILD_TIMEOUT_MS || 10 * 60 * 1000) || 10 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustMergedIndexRebuildPayload>(commandOutput.stdout)
      if (!payload.ok || !payload.rebuilt) {
        const error = new Error(payload.message || 'rust merged index rebuild returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--merged-index-rebuild') : error
      }
      const result: RustMergedIndexRebuildResult = {
        rebuilt: true,
        rows: Number(payload.rows || 0),
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-merged-index-rebuild',
        indexProtocol: payload.indexProtocol,
        timings: payload.timings || {},
      }
      options.appendStartupLog(`rust merged index rebuild finished: sources=${input.sources.length}, rows=${result.rows}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms, timings=${JSON.stringify(result.timings || {})}`)
      return result
    } catch (error) {
      if (isRustCoreDaemonSubmittedError(error)) {
        options.appendStartupLog(`rust merged index rebuild failed after daemon submit: ${error.message}; Node fallback blocked`)
        throw error
      }
      options.appendStartupLog(`rust merged index rebuild failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }


  async function runRustMergedIndexSync(input: RustMergedIndexSyncInput): Promise<RustMergedIndexSyncResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'merged-index-sync')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-merged-sync`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, [
        '--merged-index-sync',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_MERGED_SYNC_TIMEOUT_MS || 5 * 60 * 1000) || 5 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustMergedIndexSyncPayload>(commandOutput.stdout)
      if (!payload.ok || !payload.synced) {
        const error = new Error(payload.message || 'rust merged index sync returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--merged-index-sync') : error
      }
      const result: RustMergedIndexSyncResult = {
        synced: true,
        changed: Number(payload.changed || 0),
        rows: Number(payload.rows || 0),
        fullSnapshot: Boolean(payload.fullSnapshot),
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-merged-index-sync',
        indexProtocol: payload.indexProtocol,
        timings: payload.timings || {},
      }
      options.appendStartupLog(`rust merged index sync finished: root=${input.source.root}, changed=${result.changed}, rows=${result.rows}, fullSnapshot=${result.fullSnapshot}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms, timings=${JSON.stringify(result.timings || {})}`)
      return result
    } catch (error) {
      if (isRustCoreDaemonSubmittedError(error)) {
        options.appendStartupLog(`rust merged index sync failed after daemon submit: ${error.message}; Node fallback blocked`)
        throw error
      }
      options.appendStartupLog(`rust merged index sync failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }


  async function runRustWatcherPreflight(input: RustWatcherPreflightInput): Promise<RustWatcherPreflightResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'watcher-batch-preflight')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-watcher-preflight`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--watcher-batch-preflight',
        '--input', inputPath,
      ], {
        timeout: Math.max(3000, Number(process.env.HFM_RUST_WATCHER_PREFLIGHT_TIMEOUT_MS || 30 * 1000) || 30 * 1000),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustWatcherPreflightPayload>(stdout)
      if (!payload.ok || typeof payload.unchanged !== 'boolean') throw new Error(payload.message || 'rust watcher preflight returned ok=false')
      const result: RustWatcherPreflightResult = {
        unchanged: payload.unchanged,
        reason: String(payload.reason || ''),
        checkedFiles: Number(payload.checkedFiles || 0),
        checkedDirs: Number(payload.checkedDirs || 0),
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-watcher-preflight',
      }
      options.appendStartupLog(`rust watcher preflight finished: unchanged=${result.unchanged}, files=${result.checkedFiles}, dirs=${result.checkedDirs}, reason=${result.reason || 'n/a'}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      options.appendStartupLog(`rust watcher preflight failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }


  async function runRustInstallStatusRead(groups: InstallStatusReadWorkerGroup[]): Promise<RustInstallStatusReadResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'install-status-index-read')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-install-status-read`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({ groups })
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--install-status-read',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_INSTALL_STATUS_READ_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustInstallStatusReadPayload>(stdout)
      if (!payload.ok || !payload.results || !Array.isArray(payload.missingIds)) throw new Error(payload.message || 'rust install status read returned ok=false')
      const result: RustInstallStatusReadResult = {
        results: payload.results || {},
        missingIds: payload.missingIds || [],
        timings: payload.timings || {},
        workerMode: 'rust-install-status-read',
      }
      options.appendStartupLog(`rust install status read finished: groups=${groups.length}, known=${Object.keys(result.results || {}).length}, missing=${result.missingIds.length}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      return result
    } catch (error) {
      options.appendStartupLog(`rust install status read failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--install-status-read')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustInstallStatusSave(groups: InstallStatusSaveWorkerGroup[]): Promise<RustInstallStatusSaveResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'install-status-index-save')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-install-status-save`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({ groups })
      const commandOutput = await runRustCoreScheduledCommand(status.path, [
        '--install-status-save',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_INSTALL_STATUS_SAVE_TIMEOUT_MS || 5 * 60 * 1000) || 5 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustInstallStatusSavePayload>(commandOutput.stdout)
      if (!payload.ok || typeof payload.written !== 'number') {
        const error = new Error(payload.message || 'rust install status save returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--install-status-save') : error
      }
      const result: RustInstallStatusSaveResult = {
        written: Number(payload.written || 0),
        groups: Number(payload.groups || 0),
        timings: payload.timings || {},
        workerMode: 'rust-install-status-save',
      }
      options.appendStartupLog(`rust install status save finished: groups=${groups.length}, written=${result.written}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      return result
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, 'rust install status save')
      options.appendStartupLog(`rust install status save failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--install-status-save')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustInstallStatusCompare(input: RustInstallStatusCompareInput): Promise<RustInstallStatusCompareResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'install-status-compare')) return null

    const cleanItems = (input.items || []).filter((item) => item?.id)
    if (!cleanItems.length) return { results: {}, count: 0, elapsedMs: 0, workerMode: 'rust-install-status-compare' }

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-install-status-compare`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({
        appName: input.appName,
        items: cleanItems,
        installed: input.installed || [],
      })
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--install-status-compare',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_INSTALL_STATUS_COMPARE_TIMEOUT_MS || 5 * 60 * 1000) || 5 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustInstallStatusComparePayload>(stdout)
      if (!payload.ok || !payload.results) throw new Error(payload.message || 'rust install status compare returned ok=false')
      const result: RustInstallStatusCompareResult = {
        results: payload.results || {},
        count: Number(payload.count || Object.keys(payload.results || {}).length),
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-install-status-compare',
      }
      options.appendStartupLog(`rust install status compare finished: items=${cleanItems.length}, installed=${input.installed?.length || 0}, results=${Object.keys(result.results).length}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      options.appendStartupLog(`rust install status compare failed: ${error instanceof Error ? error.message : String(error)}; Node compare fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }


  async function runRustLocalTagsRead(input: RustLocalTagsReadInput): Promise<RustLocalTagsReadResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'local-tags-read')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-local-tags-read`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--local-tags-read',
        '--input', inputPath,
      ], {
        timeout: Math.max(3000, Number(process.env.HFM_RUST_LOCAL_TAGS_READ_TIMEOUT_MS || 30 * 1000) || 30 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustLocalTagsReadPayload>(stdout)
      if (!payload.ok || !payload.tagMap || typeof payload.tagMap !== 'object') throw new Error(payload.message || 'rust local tags read returned ok=false')
      const tagMap: Record<string, string[]> = {}
      for (const [key, value] of Object.entries(payload.tagMap || {})) {
        tagMap[String(key)] = Array.isArray(value) ? value.map(String).filter(Boolean) : []
      }
      const result: RustLocalTagsReadResult = {
        tagMap,
        knownTags: Array.isArray(payload.knownTags) ? payload.knownTags.map(String).filter(Boolean) : [],
        signature: typeof payload.signature === 'string' ? payload.signature : undefined,
        timings: payload.timings || {},
        workerMode: 'rust-local-tags-read',
      }
      const elapsed = Date.now() - startedAt
      if (elapsed >= 250 || String(process.env.HFM_LOG_DETAIL || '').toLowerCase() === 'debug') {
        options.appendStartupLog(`rust local tags read finished: rows=${input.rows.length}, matched=${Object.keys(result.tagMap).length}, tags=${result.knownTags.length}, elapsed=${elapsed}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      }
      return result
    } catch (error) {
      options.appendStartupLog(`rust local tags read failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--local-tags-read')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustLocalTagsSet(input: RustLocalTagsSetInput): Promise<RustLocalTagsSetResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'local-tags-set')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-local-tags-set`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, [
        '--local-tags-set',
        '--input', inputPath,
      ], {
        timeout: Math.max(3000, Number(process.env.HFM_RUST_LOCAL_TAGS_WRITE_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustLocalTagsSetPayload>(commandOutput.stdout)
      const mutationProtocol = normalizeRustTagMutationProtocolResult(payload, {
        command: '--local-tags-set',
        domain: 'localTags',
        mutationKind: 'set',
        changedIds: payload.updatedIds,
        knownTags: payload.knownTags,
        workerMode: 'rust-local-tags-set',
      })
      if (!payload.ok || mutationProtocol.ok === false || !Array.isArray(payload.updatedIds)) {
        const error = new Error(mutationProtocol.message || payload.message || 'rust local tags set returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--local-tags-set') : error
      }
      const result: RustLocalTagsSetResult = {
        updatedIds: payload.updatedIds.map(String),
        written: Number(payload.written || 0),
        previousKnownTags: Array.isArray(payload.previousKnownTags) ? payload.previousKnownTags.map(String) : undefined,
        knownTags: Array.isArray(payload.knownTags) ? payload.knownTags.map(String) : (mutationProtocol.knownTags || []),
        addedKnownTags: Array.isArray(payload.addedKnownTags) ? payload.addedKnownTags.map(String) : undefined,
        removedKnownTags: Array.isArray(payload.removedKnownTags) ? payload.removedKnownTags.map(String) : undefined,
        retainedEmptyTags: Array.isArray(payload.retainedEmptyTags) ? payload.retainedEmptyTags.map(String) : undefined,
        stateSignal: (mutationProtocol.stateSignal || payload.stateSignal) as RustLocalTagsMutationStateSignal | undefined,
        mutationProtocol,
        timings: mutationProtocol.timings || payload.timings || {},
        workerMode: 'rust-local-tags-set',
      }
      options.appendStartupLog(`rust local tags set finished: rows=${input.rows.length}, updated=${result.updatedIds.length}, written=${result.written}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      return result
    } catch (error) {
      if (isRustCoreDaemonSubmittedError(error)) {
        options.appendStartupLog(`rust local tags set failed after daemon submit: ${error.message}; Node fallback blocked`)
        throw error
      }
      options.appendStartupLog(`rust local tags set failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--local-tags-set')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustLocalTagsDeleteTag(input: RustLocalTagsDeleteTagInput): Promise<RustLocalTagsDeleteTagResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'local-tags-delete-tag')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-local-tags-delete`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, [
        '--local-tags-delete-tag',
        '--input', inputPath,
      ], {
        timeout: Math.max(3000, Number(process.env.HFM_RUST_LOCAL_TAGS_WRITE_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustLocalTagsDeleteTagPayload>(commandOutput.stdout)
      const mutationProtocol = normalizeRustTagMutationProtocolResult(payload, {
        command: '--local-tags-delete-tag',
        domain: 'localTags',
        mutationKind: 'deleteTag',
        changedIds: payload.updatedIds,
        knownTags: payload.knownTags,
        workerMode: 'rust-local-tags-delete',
      })
      if (!payload.ok || mutationProtocol.ok === false || !Array.isArray(payload.updatedIds)) {
        const error = new Error(mutationProtocol.message || payload.message || 'rust local tags delete returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--local-tags-delete-tag') : error
      }
      const result: RustLocalTagsDeleteTagResult = {
        updatedIds: payload.updatedIds.map(String),
        updated: Number(payload.updated || 0),
        previousKnownTags: Array.isArray(payload.previousKnownTags) ? payload.previousKnownTags.map(String) : undefined,
        knownTags: Array.isArray(payload.knownTags) ? payload.knownTags.map(String) : (mutationProtocol.knownTags || []),
        addedKnownTags: Array.isArray(payload.addedKnownTags) ? payload.addedKnownTags.map(String) : undefined,
        removedKnownTags: Array.isArray(payload.removedKnownTags) ? payload.removedKnownTags.map(String) : undefined,
        stateSignal: (mutationProtocol.stateSignal || payload.stateSignal) as RustLocalTagsMutationStateSignal | undefined,
        mutationProtocol,
        timings: mutationProtocol.timings || payload.timings || {},
        workerMode: 'rust-local-tags-delete',
      }
      options.appendStartupLog(`rust local tags delete finished: tag=${input.tagName}, updated=${result.updated}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      return result
    } catch (error) {
      if (isRustCoreDaemonSubmittedError(error)) {
        options.appendStartupLog(`rust local tags delete failed after daemon submit: ${error.message}; Node fallback blocked`)
        throw error
      }
      options.appendStartupLog(`rust local tags delete failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--local-tags-delete-tag')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustSharedMetadataApply(input: RustSharedMetadataApplyInput): Promise<RustSharedMetadataApplyResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'shared-metadata-apply')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-shared-metadata-apply`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, [
        '--shared-metadata-apply',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_SHARED_METADATA_WRITE_TIMEOUT_MS || 5 * 60 * 1000) || 5 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustSharedMetadataApplyPayload>(commandOutput.stdout)
      const mutationProtocol = normalizeRustTagMutationProtocolResult(payload, {
        command: '--shared-metadata-apply',
        domain: 'sharedMetadata',
        mutationKind: 'apply',
        changedIds: payload.changedIds,
        signature: payload.signature,
        workerMode: 'rust-shared-metadata-apply',
      })
      if (!payload.ok || mutationProtocol.ok === false || typeof payload.written !== 'number') {
        const error = new Error(mutationProtocol.message || payload.message || 'rust shared metadata apply returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--shared-metadata-apply') : error
      }
      const result: RustSharedMetadataApplyResult = {
        written: Number(payload.written || 0),
        events: Number(payload.events || 0),
        changedIds: mutationProtocol.changedIds?.length ? mutationProtocol.changedIds : (Array.isArray(payload.changedIds) ? payload.changedIds.map(String) : []),
        signature: mutationProtocol.signature || (typeof payload.signature === 'string' ? payload.signature : undefined),
        stateSignal: (mutationProtocol.stateSignal || payload.stateSignal) as RustSharedMetadataMutationStateSignal | undefined,
        mutationProtocol,
        timings: mutationProtocol.timings || payload.timings || {},
        workerMode: 'rust-shared-metadata-apply',
      }
      options.appendStartupLog(`rust shared metadata apply finished: rows=${input.rows.length}, written=${result.written}, events=${result.events}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      return result
    } catch (error) {
      if (isRustCoreDaemonSubmittedError(error)) {
        options.appendStartupLog(`rust shared metadata apply failed after daemon submit: ${error.message}; Node fallback blocked`)
        throw error
      }
      options.appendStartupLog(`rust shared metadata apply failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--shared-metadata-apply')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustSharedMetadataRemoveTag(input: RustSharedMetadataRemoveTagInput): Promise<RustSharedMetadataRemoveTagResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'shared-metadata-remove-tag')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-shared-metadata-remove-tag`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, [
        '--shared-metadata-remove-tag',
        '--input', inputPath,
      ], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_SHARED_METADATA_WRITE_TIMEOUT_MS || 5 * 60 * 1000) || 5 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustSharedMetadataRemoveTagPayload>(commandOutput.stdout)
      const mutationProtocol = normalizeRustTagMutationProtocolResult(payload, {
        command: '--shared-metadata-remove-tag',
        domain: 'sharedMetadata',
        mutationKind: 'removeTag',
        changedIds: payload.updatedIds,
        signature: payload.signature,
        workerMode: 'rust-shared-metadata-remove-tag',
      })
      if (!payload.ok || mutationProtocol.ok === false || !Array.isArray(payload.updatedIds)) {
        const error = new Error(mutationProtocol.message || payload.message || 'rust shared metadata remove tag returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--shared-metadata-remove-tag') : error
      }
      const result: RustSharedMetadataRemoveTagResult = {
        updatedIds: mutationProtocol.changedIds?.length ? mutationProtocol.changedIds : payload.updatedIds.map(String),
        updated: Number(payload.updated || 0),
        signature: mutationProtocol.signature || (typeof payload.signature === 'string' ? payload.signature : undefined),
        stateSignal: (mutationProtocol.stateSignal || payload.stateSignal) as RustSharedMetadataMutationStateSignal | undefined,
        mutationProtocol,
        timings: mutationProtocol.timings || payload.timings || {},
        workerMode: 'rust-shared-metadata-remove-tag',
      }
      options.appendStartupLog(`rust shared metadata remove tag finished: tag=${input.tagName}, updated=${result.updated}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      return result
    } catch (error) {
      if (isRustCoreDaemonSubmittedError(error)) {
        options.appendStartupLog(`rust shared metadata remove tag failed after daemon submit: ${error.message}; Node fallback blocked`)
        throw error
      }
      options.appendStartupLog(`rust shared metadata remove tag failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--shared-metadata-remove-tag')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustSharedMetadataKnownTags(input: RustSharedMetadataKnownTagsInput): Promise<RustSharedMetadataKnownTagsResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'shared-metadata-known-tags')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-shared-metadata-known-tags`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--shared-metadata-known-tags',
        '--input', inputPath,
      ], {
        timeout: Math.max(3000, Number(process.env.HFM_RUST_SHARED_METADATA_KNOWN_TAGS_TIMEOUT_MS || 45 * 1000) || 45 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustSharedMetadataKnownTagsPayload>(stdout)
      if (!payload.ok || !Array.isArray(payload.knownTags)) throw new Error(payload.message || 'rust shared metadata known tags returned ok=false')
      const result: RustSharedMetadataKnownTagsResult = {
        knownTags: payload.knownTags.map(String).filter(Boolean),
        roots: Array.isArray(payload.roots) ? payload.roots.map((root) => ({
          rootPath: String(root?.rootPath || ''),
          dbPath: String(root?.dbPath || ''),
          signature: String(root?.signature || 'metadata:none'),
          knownTags: Array.isArray(root?.knownTags) ? root.knownTags.map(String).filter(Boolean) : [],
          rows: Number(root?.rows || 0),
        })) : [],
        timings: payload.timings || {},
        workerMode: 'rust-shared-metadata-known-tags',
      }
      const elapsed = Date.now() - startedAt
      if (elapsed >= 250 || String(process.env.HFM_LOG_DETAIL || '').toLowerCase() === 'debug') {
        options.appendStartupLog(`rust shared metadata known tags finished: roots=${input.roots.length}, tags=${result.knownTags.length}, elapsed=${elapsed}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      }
      return result
    } catch (error) {
      options.appendStartupLog(`rust shared metadata known tags failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--shared-metadata-known-tags')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustSharedMetadataOverlayRead(input: RustSharedMetadataOverlayReadInput): Promise<RustSharedMetadataOverlayReadResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'shared-metadata-overlay-read')) return null

    const cleanEntries = Array.isArray(input.entries)
      ? input.entries.map((entry) => ({
        key: String(entry?.key || ''),
        fontId: String(entry?.fontId || ''),
        relativePath: String(entry?.relativePath || ''),
        pathKey: String(entry?.pathKey || ''),
      })).filter((entry) => entry.key)
      : []
    if (!cleanEntries.length) {
      return {
        rootPath: input.rootPath,
        dbPath: input.dbPath,
        signature: 'metadata:none',
        matched: [],
        rows: 0,
        requested: 0,
        timings: {},
        workerMode: 'rust-shared-metadata-overlay-read',
      }
    }

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-shared-metadata-overlay-read`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({
        rootPath: input.rootPath,
        dbPath: input.dbPath,
        entries: cleanEntries,
      })
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--shared-metadata-overlay-read',
        '--input', inputPath,
      ], {
        timeout: Math.max(3000, Number(process.env.HFM_RUST_SHARED_METADATA_OVERLAY_READ_TIMEOUT_MS || 45 * 1000) || 45 * 1000),
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustSharedMetadataOverlayReadPayload>(stdout)
      if (!payload.ok || !Array.isArray(payload.matched)) throw new Error(payload.message || 'rust shared metadata overlay read returned ok=false')
      const result: RustSharedMetadataOverlayReadResult = {
        rootPath: String(payload.rootPath || input.rootPath || ''),
        dbPath: String(payload.dbPath || input.dbPath || ''),
        signature: String(payload.signature || 'metadata:none'),
        matched: payload.matched.map((item) => ({
          key: String(item?.key || ''),
          tagNames: Array.isArray(item?.tagNames) ? item.tagNames.map(String).filter(Boolean) : [],
          favorite: !!item?.favorite,
          deleteProtected: !!item?.deleteProtected,
          matchedBy: typeof item?.matchedBy === 'string' ? item.matchedBy : undefined,
        })).filter((item) => item.key),
        rows: Number(payload.rows || 0),
        requested: Number(payload.requested || cleanEntries.length),
        timings: payload.timings || {},
        workerMode: 'rust-shared-metadata-overlay-read',
      }
      const elapsed = Date.now() - startedAt
      if (result.matched.length || elapsed >= 250 || String(process.env.HFM_LOG_DETAIL || '').toLowerCase() === 'debug') {
        options.appendStartupLog(`rust shared metadata overlay read finished: root=${input.rootPath}, requested=${cleanEntries.length}, matched=${result.matched.length}, rows=${result.rows}, elapsed=${elapsed}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      }
      return result
    } catch (error) {
      options.appendStartupLog(`rust shared metadata overlay read failed: ${error instanceof Error ? error.message : String(error)}; ${rustStateFallbackFailureLogSuffix('--shared-metadata-overlay-read')}`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustSharedMetadataSignature(input: RustSharedMetadataSignatureInput): Promise<RustSharedMetadataSignatureResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'shared-metadata-signature')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-shared-metadata-signature`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, [
        '--shared-metadata-signature',
        '--input', inputPath,
      ], {
        timeout: Math.max(3000, Number(process.env.HFM_RUST_SHARED_METADATA_SIGNATURE_TIMEOUT_MS || 30 * 1000) || 30 * 1000),
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustSharedMetadataSignaturePayload>(stdout)
      if (!payload.ok || typeof payload.signature !== 'string') throw new Error(payload.message || 'rust shared metadata signature returned ok=false')
      const result: RustSharedMetadataSignatureResult = {
        signature: payload.signature || 'metadata:none',
        timings: payload.timings || {},
        workerMode: 'rust-shared-metadata-signature',
      }
      const elapsed = Date.now() - startedAt
      if (elapsed >= 250 || String(process.env.HFM_LOG_DETAIL || '').toLowerCase() === 'debug') {
        options.appendStartupLog(`rust shared metadata signature finished: elapsed=${elapsed}ms, workerElapsed=${result.timings?.elapsed || 0}ms`)
      }
      return result
    } catch (error) {
      options.appendStartupLog(`rust shared metadata signature failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustPreviewCacheReadStatus(input: RustPreviewCacheReadStatusInput): Promise<RustPreviewCacheReadStatusResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'preview-cache-index-read')) return null

    const payload = await runRustPreviewCacheInputCommand<RustPreviewCacheReadStatusPayload>('read-status', '--preview-cache-read-status', input)
    if (!payload || !payload.ok) return null
    const normalizedStatus = normalizePreviewCacheStatusPayload(payload.status)
    return {
      status: normalizedStatus,
      matched: Boolean(payload.matched),
      touched: Boolean(payload.touched),
      timings: payload.timings || {},
      workerMode: 'rust-preview-cache-read-status',
    }
  }

  async function runRustPreviewCacheApply(input: RustPreviewCacheApplyInput): Promise<RustPreviewCacheApplyResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'preview-cache-index-apply')) return null

    const payload = await runRustPreviewCacheInputCommand<RustPreviewCacheApplyPayload>('apply', '--preview-cache-apply', input)
    if (!payload || !payload.ok || typeof payload.written !== 'number') return null
    return {
      written: Number(payload.written || 0),
      timings: payload.timings || {},
      workerMode: 'rust-preview-cache-apply',
    }
  }

  async function runRustPreviewCacheDelete(input: RustPreviewCacheDeleteInput): Promise<RustPreviewCacheDeleteResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'preview-cache-index-delete')) return null

    const payload = await runRustPreviewCacheInputCommand<RustPreviewCacheDeletePayload>('delete', '--preview-cache-delete', input)
    if (!payload || !payload.ok || typeof payload.deleted !== 'number') return null
    return {
      deleted: Number(payload.deleted || 0),
      timings: payload.timings || {},
      workerMode: 'rust-preview-cache-delete',
    }
  }

  async function runRustPreviewCacheQuery(input: RustPreviewCacheQueryInput): Promise<RustPreviewCacheQueryResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'preview-cache-index-query')) return null

    const payload = await runRustPreviewCacheInputCommand<RustPreviewCacheQueryPayload>('query', '--preview-cache-query', input)
    if (!payload || !payload.ok || !Array.isArray(payload.rows)) return null
    return {
      rows: payload.rows.map((row) => ({
        id: String(row.id || ''),
        previewKey: String(row.previewKey || ''),
        outputPath: String(row.outputPath || ''),
        status: normalizePreviewCacheStatusPayload(row.status),
        matched: Boolean(row.matched),
      })),
      matched: Number(payload.matched || 0),
      touched: Number(payload.touched || 0),
      timings: payload.timings || {},
      workerMode: 'rust-preview-cache-query',
    }
  }

  async function runRustPreviewCacheTouch(input: RustPreviewCacheTouchInput): Promise<RustPreviewCacheTouchResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'preview-cache-index-touch')) return null

    const payload = await runRustPreviewCacheInputCommand<RustPreviewCacheTouchPayload>('touch', '--preview-cache-touch', input)
    if (!payload || !payload.ok || typeof payload.touched !== 'number') return null
    return {
      touched: Number(payload.touched || 0),
      timings: payload.timings || {},
      workerMode: 'rust-preview-cache-touch',
    }
  }

  async function runRustPreviewCacheBatch(input: RustPreviewCacheBatchInput): Promise<RustPreviewCacheBatchResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'preview-cache-batch')) return null

    const payload = await runRustPreviewCacheInputCommand<RustPreviewCacheBatchPayload>('batch', '--preview-cache-batch', input)
    if (!payload || !payload.ok || !Array.isArray(payload.rows)) return null
    return {
      rows: payload.rows.map((row) => ({
        id: String(row.id || ''),
        previewKey: String(row.previewKey || ''),
        outputPath: String(row.outputPath || ''),
        status: normalizePreviewCacheStatusPayload(row.status),
        matched: Boolean(row.matched),
        fileExists: Boolean(row.fileExists),
      })),
      matched: Number(payload.matched || 0),
      touched: Number(payload.touched || 0),
      missingIds: Array.isArray(payload.missingIds) ? payload.missingIds.filter((id): id is string => typeof id === 'string') : [],
      timings: payload.timings || {},
      workerMode: 'rust-preview-cache-batch',
    }
  }

  async function runRustPreviewCacheMaintenance(input: RustPreviewCacheMaintenanceInput): Promise<RustPreviewCacheMaintenanceResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'preview-cache-maintenance')) return null

    const payload = await runRustPreviewCacheInputCommand<RustPreviewCacheMaintenancePayload>('maintenance', '--preview-cache-maintenance', input)
    if (!payload || !payload.ok) return null
    return {
      checkedRows: Number(payload.checkedRows || 0),
      staleRows: Number(payload.staleRows || 0),
      removedFiles: Number(payload.removedFiles || 0),
      removedOrphanFiles: Number(payload.removedOrphanFiles || 0),
      errors: Array.isArray(payload.errors) ? payload.errors.map(String) : [],
      timings: payload.timings || {},
      workerMode: 'rust-preview-cache-maintenance',
    }
  }

  async function runRustPreviewCacheInputCommand<T extends { ok?: boolean; message?: string }>(label: string, command: string, input: unknown): Promise<T | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-preview-cache-${label}`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, [command, '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_PREVIEW_CACHE_DB_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      const payload = parseJsonLine<T>(stdout)
      if (!payload.ok) throw new Error(payload.message || `rust preview cache ${label} returned ok=false`)
      const elapsedMs = Date.now() - startedAt
      if (label !== 'batch' || elapsedMs >= 800 || process.env.HFM_LOG_DETAIL === 'debug' || process.env.HFM_VERBOSE_LOGS === '1') {
        options.appendStartupLog(`rust preview cache ${label} finished: elapsed=${elapsedMs}ms`)
      }
      return payload
    } catch (error) {
      appendPreviewCacheFailureLog(label, error instanceof Error ? error.message : String(error))
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustFontResourceAdd(paths: string[], options: { notify?: boolean; reason?: string; strong?: boolean } = {}): Promise<RustFontResourceBatchResult | null> {
    return runRustFontResourceBatch('add', '--font-resource-add', 'font-resource-add', paths, options)
  }

  async function runRustFontResourceRemove(paths: string[], options: { notify?: boolean; reason?: string; strong?: boolean } = {}): Promise<RustFontResourceBatchResult | null> {
    return runRustFontResourceBatch('remove', '--font-resource-remove', 'font-resource-remove', paths, options)
  }

  async function runRustFontResourceBatch(
    label: 'add' | 'remove',
    command: string,
    capability: string,
    paths: string[],
    batchOptions: { notify?: boolean; reason?: string; strong?: boolean } = {},
  ): Promise<RustFontResourceBatchResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, capability)) return null

    const cleanPaths = Array.from(new Set(paths.filter(Boolean)))
    if (!cleanPaths.length) return {}

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-font-resource-${label}`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({ paths: cleanPaths, notify: Boolean(batchOptions.notify), strong: Boolean(batchOptions.strong) })
      const commandOutput = await runRustCoreScheduledCommand(status.path, [command, '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_FONT_RESOURCE_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      const payload = parseJsonLine<RustFontResourceBatchPayload>(commandOutput.stdout)
      if (!Array.isArray(payload.results)) {
        const error = new Error(payload.message || `rust font resource ${label} returned no results`)
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, command) : error
      }
      const results: RustFontResourceBatchResult = {}
      for (const row of payload.results) {
        const path = String(row.path || '')
        if (!path) continue
        results[path] = {
          ok: Boolean(row.ok),
          count: Number(row.count || 0),
          message: String(row.message || ''),
        }
      }
      const okCount = Number(payload.count || Object.values(results).filter((entry) => entry.ok).length)
      const failedCount = Number(payload.failed || Object.values(results).filter((entry) => !entry.ok).length)
      const workerElapsed = Number(payload.elapsedMs || Date.now() - startedAt)
      options.appendStartupLog(`rust font resource ${label} finished: reason=${batchOptions.reason || 'n/a'}, paths=${cleanPaths.length}, ok=${okCount}, failed=${failedCount}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${workerElapsed}ms`)
      return results
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, `rust font resource ${label}`)
      options.appendStartupLog(`rust font resource ${label} failed: ${error instanceof Error ? error.message : String(error)}; native helper fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustFontRegistryApply(records: Array<{ name: string; path: string }>): Promise<RustFontRegistryResult | null> {
    return runRustFontRegistryCommand('apply', '--font-registry-apply', 'font-registry-apply', { records })
  }

  async function runRustFontRegistryDelete(names: string[]): Promise<RustFontRegistryResult | null> {
    return runRustFontRegistryCommand('delete', '--font-registry-delete', 'font-registry-delete', { names })
  }

  async function runRustFontRegistryCommand(
    label: 'apply' | 'delete',
    command: string,
    capability: string,
    input: unknown,
  ): Promise<RustFontRegistryResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, capability)) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-font-registry-${label}`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, [command, '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_FONT_REGISTRY_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      })
      const payload = parseJsonLine<RustFontRegistryPayload>(commandOutput.stdout)
      if (!payload.ok) {
        const error = new Error(payload.message || `rust font registry ${label} returned ok=false`)
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, command) : error
      }
      const result: RustFontRegistryResult = {
        ok: true,
        count: Number(payload.count || 0),
        failed: Number(payload.failed || 0),
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: label === 'apply' ? 'rust-font-registry-apply' : 'rust-font-registry-delete',
      }
      options.appendStartupLog(`rust font registry ${label} finished: count=${result.count}, failed=${result.failed}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, `rust font registry ${label}`)
      options.appendStartupLog(`rust font registry ${label} failed: ${error instanceof Error ? error.message : String(error)}; native helper fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustFontChangeNotify(input: { strong?: boolean; reason?: string } = {}): Promise<RustFontNotifyResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'font-resource-notify')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-font-notify`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson({ strong: Boolean(input.strong) })
      const commandOutput = await runRustCoreScheduledCommand(status.path, ['--font-resource-notify', '--input', inputPath], {
        timeout: Math.max(1000, Number(process.env.HFM_RUST_FONT_NOTIFY_TIMEOUT_MS || 3000) || 3000),
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      const payload = parseJsonLine<RustFontNotifyPayload>(commandOutput.stdout)
      if (!payload.ok) {
        const error = new Error(payload.message || 'rust font notify returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--font-resource-notify') : error
      }
      const result: RustFontNotifyResult = {
        ok: true,
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-font-change-notify',
      }
      options.appendStartupLog(`rust WM_FONTCHANGE ${input.strong ? 'strong' : 'light'} broadcast sent: ${input.reason || 'manual'}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, 'rust WM_FONTCHANGE')
      options.appendStartupLog(`rust WM_FONTCHANGE failed: ${error instanceof Error ? error.message : String(error)}; native helper fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }


  async function runRustPhysicalFolderTree(input: RustPhysicalFolderTreeInput): Promise<RustPhysicalFolderTreeResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'physical-folder-tree')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-folder-tree`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const { stdout } = await runRustCoreScheduledCommand(status.path, ['--physical-folder-tree', '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_FOLDER_TREE_TIMEOUT_MS || 2 * 60 * 1000) || 2 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })
      const payload = parseJsonLine<RustPhysicalFolderTreePayload>(stdout)
      if (!payload.ok || !Array.isArray(payload.folders) || !Array.isArray(payload.nodes)) throw new Error(payload.message || 'rust physical folder tree returned ok=false')
      const result: RustPhysicalFolderTreeResult = {
        folders: payload.folders.filter((folder): folder is string => typeof folder === 'string'),
        nodes: payload.nodes.map((node) => ({
          id: String(node.id || ''),
          name: String(node.name || ''),
          parentId: String(node.parentId || ''),
          rootPath: String(node.rootPath || ''),
          createdAt: String(node.createdAt || ''),
        })).filter((node) => Boolean(node.id && node.name)),
        errors: Array.isArray(payload.errors) ? payload.errors.map(String) : [],
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-physical-folder-tree',
      }
      options.appendStartupLog(`rust physical folder tree finished: roots=${result.folders.length}, nodes=${result.nodes.length}, errors=${result.errors.length}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      options.appendStartupLog(`rust physical folder tree failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustFontActivationFiles(input: RustFontActivationFilesInput): Promise<RustFontActivationFilesResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'font-activation-files')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-activation-files`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, ['--font-activation-files', '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_ACTIVATION_FILES_TIMEOUT_MS || 2 * 60 * 1000) || 2 * 60 * 1000),
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
      })
      const payload = parseJsonLine<RustFontActivationFilesPayload>(commandOutput.stdout)
      if (!payload.ok) {
        const error = new Error(payload.message || 'rust font activation files returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--font-activation-files') : error
      }
      const result: RustFontActivationFilesResult = {
        ok: true,
        copied: Number(payload.copied || 0),
        reused: Number(payload.reused || 0),
        deleted: Number(payload.deleted || 0),
        failed: Number(payload.failed || 0),
        copyResults: Array.isArray(payload.copyResults) ? payload.copyResults.map((row) => ({ id: String(row.id || ''), source: String(row.source || ''), dest: String(row.dest || ''), ok: Boolean(row.ok), mode: String(row.mode || ''), message: String(row.message || '') })) : [],
        deleteResults: Array.isArray(payload.deleteResults) ? payload.deleteResults.map((row) => ({ path: String(row.path || ''), ok: Boolean(row.ok), message: String(row.message || '') })) : [],
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-font-activation-files',
      }
      options.appendStartupLog(`rust font activation files finished: copied=${result.copied}, reused=${result.reused}, deleted=${result.deleted}, failed=${result.failed}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, 'rust font activation files')
      options.appendStartupLog(`rust font activation files failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustPreviewRenderImage(input: RustPreviewRenderImageInput): Promise<RustPreviewRenderImageResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'preview-render-image')) return null

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-preview-render`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, ['--preview-render-image', '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_PREVIEW_RENDER_TIMEOUT_MS || 30 * 1000) || 30 * 1000),
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      const payload = parseJsonLine<RustPreviewRenderImagePayload>(commandOutput.stdout)
      if (!payload.ok || !payload.outputPath) {
        const error = new Error(payload.message || 'rust preview render returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--preview-render-image') : error
      }
      const result: RustPreviewRenderImageResult = {
        ok: true,
        engine: 'rust-directwrite',
        outputPath: payload.outputPath || input.outputPath,
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-preview-render-image',
      }
      options.appendStartupLog(`rust preview render finished: output=${result.outputPath}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, 'rust preview render')
      options.appendStartupLog(`rust preview render failed: ${error instanceof Error ? error.message : String(error)}; directwrite helper fallback remains active`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  async function runRustSystemInstalledFonts(input: RustSystemInstalledFontsInput): Promise<RustSystemInstalledFontsResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'system-installed-fonts')) return null

    const startedAt = Date.now()
    try {
      const args = [
        '--system-installed-fonts',
        '--windows-fonts-dir', input.windowsFontsDir,
        '--current-user-fonts-dir', input.currentUserFontsDir,
        '--extensions', input.extensions.map((value) => value.replace(/^\./, '').toLowerCase()).join(','),
      ]
      if (input.includeNameCandidates) args.push('--include-name-candidates')

      const { stdout } = await runRustCoreScheduledCommand(status.path, args, {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_SYSTEM_INSTALLED_FONTS_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
      })

      const payload = parseJsonLine<RustSystemInstalledFontsPayload>(stdout)
      if (!payload.ok || !Array.isArray(payload.items)) throw new Error(payload.message || 'rust system installed fonts returned ok=false')
      const items = payload.items.filter((item): item is SystemInstalledFont => {
        return !!item && typeof item.source === 'string' && typeof item.registryName === 'string' && typeof item.value === 'string'
      })
      const result: RustSystemInstalledFontsResult = {
        items,
        count: Number(payload.count ?? items.length),
        registryCount: Number(payload.registryCount || 0),
        folderCount: Number(payload.folderCount || 0),
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-system-installed-fonts',
      }
      options.appendStartupLog(`rust system installed fonts read finished: items=${result.items.length}, registry=${result.registryCount}, folder=${result.folderCount}, includeNameCandidates=${Boolean(input.includeNameCandidates)}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms`)
      return result
    } catch (error) {
      options.appendStartupLog(`rust system installed fonts read failed: ${error instanceof Error ? error.message : String(error)}; Node fallback remains active`)
      return null
    }
  }

  return {
    diagnoseRustCoreWorker,
    rustCoreWorkerStatus: transport.rustCoreWorkerStatus,
    invalidateRustCoreSchedulerCaches,
    cancelRustCoreSchedulerScopes,
    noteRustCoreSchedulerInteractiveActivity,
    rustCoreDaemonStatus: transport.rustCoreDaemonStatus,
    stopRustCoreDaemon: transport.stopRustCoreDaemon,
    runRustFontIndexListWorker,
    runRustFontParseBatch,
    runRustRootIndexApplyChanges,
    runRustMergedIndexPageQuery,
    runRustMergedIndexIdsQuery,
    runRustMergedIndexMetricsQuery,
    runRustMergedIndexRebuild,
    runRustMergedIndexSync,
    runRustWatcherPreflight,
    runRustInstallStatusRead,
    runRustInstallStatusSave,
    runRustInstallStatusCompare,
    runRustLocalTagsRead,
    runRustLocalTagsSet,
    runRustLocalTagsDeleteTag,
    runRustSharedMetadataApply,
    runRustSharedMetadataRemoveTag,
    runRustSharedMetadataKnownTags,
    runRustSharedMetadataOverlayRead,
    runRustSharedMetadataSignature,
    runRustPreviewCacheReadStatus,
    runRustPreviewCacheApply,
    runRustPreviewCacheDelete,
    runRustPreviewCacheQuery,
    runRustPreviewCacheTouch,
    runRustPreviewCacheBatch,
    runRustPreviewCacheMaintenance,
    runRustDatabaseHealthCheck,
    runRustDatabaseBackup,
    runRustFontResourceAdd,
    runRustFontResourceRemove,
    runRustFontRegistryApply,
    runRustFontRegistryDelete,
    runRustFontChangeNotify,
    runRustPhysicalFolderTree,
    runRustFontActivationFiles,
    runRustPreviewRenderImage,
    runRustSystemInstalledFonts,
  }
}
