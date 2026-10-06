import { detailedStartupLogsEnabled } from '../../logging/startupLogPolicy'
import { sharedDatabaseTarget } from '../rustSharedIoCommandRuntime'
import type { SharedIoAccessPath } from '../../path/sharedIoAccessRuntime'
import { rethrowSharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { tracePreviewCacheMutation } from '../../logging/previewCacheMutationTrace'
import { parseJsonLine, hasCapability } from '../rustCoreWorkerTransportRuntime'
import type { PreviewCacheIndexStatus } from '../../preview/previewCacheRuntime'
import {
  rethrowRustCoreDaemonSubmittedJob,
  markRustCoreDaemonSubmittedError,
} from '../rustCoreDaemonWriteBoundaryRuntime'
import type {
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
  RustPreviewRenderImageInput,
  RustPreviewRenderImageResult,
} from '../rustCoreWorkerContracts'
import type {
  RustPreviewCacheReadStatusPayload,
  RustPreviewCacheApplyPayload,
  RustPreviewCacheDeletePayload,
  RustPreviewCacheQueryPayload,
  RustPreviewCacheTouchPayload,
  RustPreviewCacheBatchPayload,
  RustPreviewCacheMaintenancePayload,
  RustPreviewRenderImagePayload,
} from '../rustCoreWorkerPayloadTypes'
import type { RustCoreWorkerRuntimeOptions } from '../rustCoreWorkerContracts'
import type { RustCoreWorkerTransportRuntime } from '../rustCoreWorkerTransportRuntime'

export type RustPreviewClientOptions = Pick<RustCoreWorkerTransportRuntime,
  'diagnoseRustCoreWorker' | 'runRustCoreScheduledCommand' | 'createTemporaryJsonFile' | 'appendPreviewCacheFailureLog'> & Pick<RustCoreWorkerRuntimeOptions, 'appendStartupLog'>

function normalizePreviewCacheStatusPayload(value: unknown): PreviewCacheIndexStatus | null {
  return value === 'ok' || value === 'missing' || value === 'failed' || value === 'pending' || value === 'generating' || value === 'stale' ? value : null
}

function previewProvenance(input: unknown): Record<string, string | number> | undefined {
  if (!input || typeof input !== 'object') return undefined
  const source = input as Record<string, unknown>, result: Record<string, string | number> = {}
  const allowed: Record<string, string[]> = {route:['private-file','system-family'],selection:['first-private-family','first-successful-system-candidate'],familyNameStatus:['observed','unavailable'],faceStatus:['not-exposed'],glyphFallbackStatus:['not-observed']}
  for (const key of ['route', 'selection', 'familyName', 'familyNameStatus', 'faceStatus', 'glyphFallbackStatus']) {
    const value = source[key]
    if (typeof value === 'string' && (key === 'familyName' || allowed[key]?.includes(value))) result[key] = value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64)
  }
  for (const key of ['requestedStyleBits', 'selectedStyleBits']) if (Number.isSafeInteger(source[key]) && Number(source[key]) >= 0 && Number(source[key]) <= 15) result[key] = Number(source[key])
  return Object.keys(result).length ? result : undefined
}
let provenanceSamples = 0

export function createRustPreviewClientRuntime(options: RustPreviewClientOptions) {
  const { diagnoseRustCoreWorker, runRustCoreScheduledCommand, createTemporaryJsonFile, appendPreviewCacheFailureLog } = options

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
    if (input.batch && !hasCapability(status, 'preview-cache-maintenance-bounded-v1')) return null

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
    return tracePreviewCacheMutation(label, options.appendStartupLog, async () => {
      const mutation = label === 'apply' || label === 'delete'
      const boundedMaintenance = label === 'maintenance' && !!(input as RustPreviewCacheMaintenanceInput).batch
      const status = await diagnoseRustCoreWorker()
      if (!status.available || !status.path) return null
      const declaration = input as { dbPath: string; readOnly?: boolean; checkFiles?: boolean; rows?: Array<{outputPath: string}>; previewDirs?: string[]; batch?: RustPreviewCacheMaintenanceInput['batch'] }
      const query = label === 'read-status' || label === 'query' || label === 'batch'
      // Old workers may ignore JSON fields. Never grant them a read description.
      if (query && declaration.readOnly && !hasCapability(status, 'preview-cache-read-only-v1')) return null
      const readOnly = query && declaration.readOnly === true
      const accesses: SharedIoAccessPath[] = sharedDatabaseTarget(declaration.dbPath, !readOnly).accesses!
      if (label === 'batch' && declaration.checkFiles) for (const row of declaration.rows || []) accesses.push({path: row.outputPath, scope: 'file', mode: 'read'})
      if (label === 'maintenance') {
        if (declaration.batch) {
          // Repeat the capability check at the actual submission boundary.
          if (!hasCapability(status, 'preview-cache-maintenance-bounded-v1')) return null
          for (const path of [...declaration.batch.rows.map(row => row.outputPath), ...declaration.batch.orphanFiles])
            if (path) accesses.push({ path, scope: 'file', mode: 'write' })
          if (declaration.batch.referenceDbPath) accesses.push(...sharedDatabaseTarget(declaration.batch.referenceDbPath, false).accesses!)
        } else for (const path of declaration.previewDirs || []) accesses.push({path, scope: 'tree', mode: 'write'})
      }
      const startedAt = Date.now()
      const inputFile = createTemporaryJsonFile(`hfm-rust-preview-cache-${label}`)
      const inputPath = inputFile.path
      let submitted = false
      try {
        await inputFile.writeJson(input)
        submitted = true
        const { stdout } = await runRustCoreScheduledCommand(status.path, [command, '--input', inputPath], {
          timeout: Math.max(5000, Number(process.env.HFM_RUST_PREVIEW_CACHE_DB_TIMEOUT_MS || 60 * 1000) || 60 * 1000),
          sharedIo: { paths: accesses.map(access => access.path), accesses, write: !readOnly },
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
        })
        const payload = parseJsonLine<T>(stdout)
        if (!payload.ok) throw new Error(payload.message || `rust preview cache ${label} returned ok=false`)
        if (boundedMaintenance) {
          const report = payload as unknown as RustPreviewCacheMaintenanceResult
          if (!['checkedRows', 'staleRows', 'removedFiles', 'removedOrphanFiles'].every(key => {
            const value = (report as unknown as Record<string, unknown>)[key]
            return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
          }) || !Array.isArray(report.errors) || report.checkedRows > declaration.batch!.rows.length ||
            report.staleRows > report.checkedRows || report.removedFiles > report.checkedRows ||
            report.removedOrphanFiles > declaration.batch!.orphanFiles.length) throw new Error('rust bounded maintenance missing valid commit result')
        }
        if (mutation) {
          const count = (payload as { written?: unknown; deleted?: unknown })[label === 'apply' ? 'written' : 'deleted']
          if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw new Error(`rust preview cache ${label} missing valid commit result`)
        }
        const elapsedMs = Date.now() - startedAt
        if (label !== 'batch' || elapsedMs >= 800 || process.env.HFM_LOG_DETAIL === 'debug' || process.env.HFM_VERBOSE_LOGS === '1') {
          if (mutation) {
            try { options.appendStartupLog(`rust preview cache ${label} finished: elapsed=${elapsedMs}ms`) } catch { /* Committed result is authoritative. */ }
          } else options.appendStartupLog(`rust preview cache ${label} finished: elapsed=${elapsedMs}ms`)
        }
        return payload
      } catch (error) {
      rethrowSharedIoProcessError(error)
        if ((mutation || boundedMaintenance) && submitted) {
          try { appendPreviewCacheFailureLog(label, error instanceof Error ? error.message : String(error)) } catch { /* Preserve the original uncertainty. */ }
          throw error
        }
        appendPreviewCacheFailureLog(label, error instanceof Error ? error.message : String(error))
        return null
      } finally {
        try { await inputFile.dispose() } catch (error) {
      rethrowSharedIoProcessError(error)
          // Cleanup failure cannot turn a settled write into replay.
          if (!mutation && !boundedMaintenance) throw error
        }
      }
    })
  }

  async function runRustPreviewRenderImage(input: RustPreviewRenderImageInput): Promise<RustPreviewRenderImageResult | null> {
    const status = await diagnoseRustCoreWorker()
    if (!status.available || !status.path || !hasCapability(status, 'preview-render-image')) return null
    const layoutCapability = input.layout ? `preview-layout-${input.layout.version}` : ''
    if (input.layout && !hasCapability(status, layoutCapability)) {
      options.appendStartupLog(`rust preview layout unavailable: ${layoutCapability}; rebuild worker required`)
      return null
    }

    const startedAt = Date.now()
    const inputFile = createTemporaryJsonFile(`hfm-rust-preview-render`)
    const inputPath = inputFile.path
    try {
      await inputFile.writeJson(input)
      const commandOutput = await runRustCoreScheduledCommand(status.path, ['--preview-render-image', '--input', inputPath], {
        timeout: Math.max(5000, Number(process.env.HFM_RUST_PREVIEW_RENDER_TIMEOUT_MS || 30 * 1000) || 30 * 1000),
        sharedIo: { paths: [input.fontPath, input.outputPath], write: true, preview: true,
          accesses: [{ path: input.fontPath, mode: 'read', scope: 'file' }, { path: input.outputPath, mode: 'write', scope: 'file' }] },
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      })
      const payload = parseJsonLine<RustPreviewRenderImagePayload>(commandOutput.stdout)
      if (!payload.ok || !payload.outputPath || (input.layout && payload.layoutVersion !== input.layout.version)) {
        const error = new Error(payload.message || 'rust preview render returned ok=false')
        throw commandOutput.daemon ? markRustCoreDaemonSubmittedError(error, '--preview-render-image') : error
      }
      const result: RustPreviewRenderImageResult = {
        ok: true,
        engine: 'rust-directwrite',
        nativeBackend: typeof payload.engine === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(payload.engine) ? payload.engine : undefined,
        provenance: previewProvenance(payload.provenance),
        outputPath: payload.outputPath || input.outputPath,
        elapsedMs: Number(payload.elapsedMs || Date.now() - startedAt),
        workerMode: 'rust-preview-render-image',
      }
      const provenanceDetail = result.provenance && detailedStartupLogsEnabled() && provenanceSamples++ < 32 ? `, provenance=${JSON.stringify(result.provenance)}` : ''
      options.appendStartupLog(`rust preview render finished: output=${result.outputPath}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms${result.nativeBackend ? `, engine=${result.engine}, nativeBackend=${result.nativeBackend}${provenanceDetail}` : ''}`)
      return result
    } catch (error) {
      rethrowSharedIoProcessError(error)
      rethrowRustCoreDaemonSubmittedJob(error, options.appendStartupLog, 'rust preview render')
      options.appendStartupLog(`rust preview render failed: ${error instanceof Error ? error.message : String(error)}; fallback decision deferred to preview dispatcher`)
      return null
    } finally {
      await inputFile.dispose()
    }
  }

  return {
    runRustPreviewCacheReadStatus,
    runRustPreviewCacheApply,
    runRustPreviewCacheDelete,
    runRustPreviewCacheQuery,
    runRustPreviewCacheTouch,
    runRustPreviewCacheBatch,
    runRustPreviewCacheMaintenance,
    runRustPreviewRenderImage,
  }
}
