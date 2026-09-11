import { parseJsonLine, hasCapability } from '../rustCoreWorkerTransportRuntime'
import type {
  InstallStatusReadWorkerGroup,
  InstallStatusSaveWorkerGroup,
} from '../../install/status/installStatusTypes'
import { isRustCoreDaemonSubmittedError } from '../rustCoreDaemonRuntime'
import {
  rethrowRustCoreDaemonSubmittedJob,
  markRustCoreDaemonSubmittedError,
} from '../rustCoreDaemonWriteBoundaryRuntime'
import { rustStateFallbackFailureLogSuffix } from '../rustStateFallbackFailureProtocolRuntime'
import type {
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
} from '../rustCoreWorkerContracts'
import type {
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
} from '../rustCoreWorkerPayloadTypes'
import type { RustCoreWorkerRuntimeOptions } from '../rustCoreWorkerContracts'
import type { RustCoreWorkerTransportRuntime } from '../rustCoreWorkerTransportRuntime'

export type RustMetadataClientOptions = Pick<RustCoreWorkerTransportRuntime,
  'diagnoseRustCoreWorker' | 'runRustCoreScheduledCommand' | 'createTemporaryJsonFile'> & Pick<RustCoreWorkerRuntimeOptions, 'appendStartupLog'>

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

export function createRustMetadataClientRuntime(options: RustMetadataClientOptions) {
  const { diagnoseRustCoreWorker, runRustCoreScheduledCommand, createTemporaryJsonFile } = options

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

  return {
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
  }
}
