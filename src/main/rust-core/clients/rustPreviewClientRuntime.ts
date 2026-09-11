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
