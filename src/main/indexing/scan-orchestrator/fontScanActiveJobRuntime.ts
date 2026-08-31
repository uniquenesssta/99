import type { FontItem,ScanResult } from '../../../shared/types'
import { normalizeWatchedFontFolders } from '../../path/fontPathPolicy'
import { isOperationCancelledError } from '../../performance/ioQueue'
import type { ActiveFontScanJob,ActiveFontScanStatus,ScanOrchestratorDeps } from './scanOrchestratorTypes'
import { createFontScanJobId } from './scanOrchestratorUtils'

function cancelledScanResult(folders: string[], durationMs = 0): ScanResult {
  return {
    folders,
    fonts: [],
    errors: [],
    stats: {
      totalFiles: 0,
      parsed: 0,
      fromCache: 0,
      reusedKnown: 0,
      skippedBad: 0,
      errors: 0,
      durationMs,
      workerCount: 0,
      queuedForWorkers: 0,
      cancelled: true,
    },
  }
}

export function createFontScanActiveJobRuntime(
  deps: Pick<ScanOrchestratorDeps, 'appendStartupLog' | 'emitFontIndexProgress' | 'recheckGlobalIoQueues' | 'globalIoSnapshot'>,
  scanFolders: (folders: string[], knownFonts?: FontItem[], options?: { jobId?: string; signal?: AbortSignal }) => Promise<ScanResult>,
): {
  scanFoldersManaged: (folders: string[], knownFonts?: FontItem[]) => Promise<ScanResult>
  cancelActiveFontScan: (reason?: string) => { cancelled: boolean; jobId?: string; message: string }
  activeFontScanStatus: () => ActiveFontScanStatus
  isActive: () => boolean
  activeJobId: () => string
} {
  let activeFontScanJob: ActiveFontScanJob | null = null
  let latestManagedRequestId = 0
  let pendingManagedRequests = 0
  let managedScanTail: Promise<void> = Promise.resolve()

  function abortActiveFontScan(reason: string): {
    cancelled: boolean
    jobId?: string
    message: string
  } {
    const active = activeFontScanJob
    if (!active || active.controller.signal.aborted)
      return { cancelled: false, message: '当前没有正在运行的索引扫描。' }
    active.controller.abort(reason)
    deps.recheckGlobalIoQueues()
    deps.appendStartupLog(`font scan cancel requested: job=${active.jobId}, reason=${reason}`)
    return { cancelled: true, jobId: active.jobId, message: reason }
  }

  function cancelActiveFontScan(reason = '索引扫描已取消。'): {
    cancelled: boolean
    jobId?: string
    message: string
  } {
    latestManagedRequestId += 1
    const activeResult = abortActiveFontScan(reason)
    if (activeResult.cancelled) return activeResult
    if (pendingManagedRequests > 0) {
      deps.appendStartupLog(`font scan queued request cancelled: pending=${pendingManagedRequests}, reason=${reason}`)
      return { cancelled: true, message: reason }
    }
    return activeResult
  }

  function activeFontScanStatus(): ActiveFontScanStatus {
    const active = activeFontScanJob
    return {
      running: !!active && !active.controller.signal.aborted,
      jobId: active?.jobId,
      folders: active?.folders,
      startedAt: active ? new Date(active.startedAt).toISOString() : undefined,
      io: deps.globalIoSnapshot(),
    }
  }

  function scanFoldersManaged(
    folders: string[],
    knownFonts: FontItem[] = [],
  ): Promise<ScanResult> {
    const normalizedFolders = normalizeWatchedFontFolders(folders, deps.appendStartupLog)
    const requestId = latestManagedRequestId += 1
    pendingManagedRequests += 1
    abortActiveFontScan('新的索引扫描已开始，旧扫描已自动取消。')

    const request = managedScanTail.then(async () => {
      if (requestId !== latestManagedRequestId) {
        deps.appendStartupLog(`font scan queued request superseded before start: request=${requestId}, latest=${latestManagedRequestId}`)
        return cancelledScanResult(normalizedFolders)
      }

      const jobId = createFontScanJobId()
      const controller = new AbortController()
      const startedAt = Date.now()
      const completion = scanFolders(normalizedFolders, knownFonts, { jobId, signal: controller.signal })
      activeFontScanJob = { jobId, folders: normalizedFolders, controller, startedAt, completion }
      deps.recheckGlobalIoQueues()

      try {
        return await completion
      } catch (error) {
        if (!isOperationCancelledError(error)) throw error
        const durationMs = Date.now() - startedAt
        deps.emitFontIndexProgress({
          jobId,
          stage: 'cancelled',
          message: '索引扫描已取消。',
          at: new Date().toISOString(),
          folders: normalizedFolders,
          durationMs,
        })
        deps.appendStartupLog(`font scan cancelled: job=${jobId}, durationMs=${durationMs}`)
        return cancelledScanResult(normalizedFolders, durationMs)
      } finally {
        if (activeFontScanJob?.jobId === jobId) activeFontScanJob = null
        deps.recheckGlobalIoQueues()
      }
    })

    managedScanTail = request.then(
      () => undefined,
      () => undefined,
    )

    return request.finally(() => {
      pendingManagedRequests = Math.max(0, pendingManagedRequests - 1)
    })
  }

  return {
    scanFoldersManaged,
    cancelActiveFontScan,
    activeFontScanStatus,
    isActive: () => Boolean(activeFontScanJob),
    activeJobId: () => activeFontScanJob?.jobId || '',
  }
}
