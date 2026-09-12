import { parseJsonLine, hasCapability } from '../rustCoreWorkerTransportRuntime'
import type { CachedFontStatLike } from '../../fonts/fontRuntime'
import type { FontParseJob } from '../../indexing/fontScanWorkers'
import { isRustCoreDaemonSubmittedError } from '../rustCoreDaemonRuntime'
import { markRustCoreDaemonSubmittedError } from '../rustCoreDaemonWriteBoundaryRuntime'
import { rustStateFallbackFailureLogSuffix } from '../rustStateFallbackFailureProtocolRuntime'
import { nodeFontkitScanFallbackFailureLogSuffix } from '../nodeFontkitScanFallbackCompatibilityRuntime'
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
  RustWatcherPreflightInput,
  RustWatcherPreflightResult,
} from '../rustCoreWorkerContracts'
import type {
  RustListFontFilesPayload,
  RustFontParseBatchPayload,
  RustApplyRootIndexPayload,
  RustMergedIndexPageQueryPayload,
  RustMergedIndexMetricsQueryPayload,
  RustMergedIndexIdsQueryPayload,
  RustMergedIndexRebuildPayload,
  RustMergedIndexSyncPayload,
  RustWatcherPreflightPayload,
} from '../rustCoreWorkerPayloadTypes'
import type { RustCoreWorkerRuntimeOptions } from '../rustCoreWorkerContracts'
import type { RustCoreWorkerTransportRuntime } from '../rustCoreWorkerTransportRuntime'

export type RustIndexingClientOptions = Pick<RustCoreWorkerTransportRuntime,
  'diagnoseRustCoreWorker' | 'runRustCoreScheduledCommand' | 'createTemporaryJsonFile'> & Pick<RustCoreWorkerRuntimeOptions, 'appendStartupLog'>

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

export function createRustIndexingClientRuntime(options: RustIndexingClientOptions) {
  const { diagnoseRustCoreWorker, runRustCoreScheduledCommand, createTemporaryJsonFile } = options

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

  return {
    runRustFontIndexListWorker,
    runRustFontParseBatch,
    runRustRootIndexApplyChanges,
    runRustMergedIndexPageQuery,
    runRustMergedIndexIdsQuery,
    runRustMergedIndexMetricsQuery,
    runRustMergedIndexRebuild,
    runRustMergedIndexSync,
    runRustWatcherPreflight,
  }
}
