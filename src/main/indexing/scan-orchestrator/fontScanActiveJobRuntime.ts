import { cacheMaintenancePending, ownsCacheMaintenance, registerCacheMaintenanceParticipant } from '../../maintenance/cacheMaintenanceCoordinator'
import type { SharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { isApplicationClosing } from '../../app/shutdownCoordinatorRuntime'
import type { FontItem,ScanResult } from '../../../shared/types'
import { normalizeWatchedFontFolders } from '../../path/fontPathPolicy'
import { isOperationCancelledError, throwIfAborted } from '../../performance/ioQueue'
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
  scanFolders: (folders: string[], knownFonts?: FontItem[], options?: { jobId?: string; signal?: AbortSignal; reuseRecoveryMetadata?: boolean }) => Promise<ScanResult>,
): {
  scanFoldersManaged: (folders: string[], knownFonts?: FontItem[]) => Promise<ScanResult>
  scanFoldersWhenIdle: (folders: string[], signal?: AbortSignal) => Promise<ScanResult>
  cancelActiveFontScan: (reason?: string) => { cancelled: boolean; jobId?: string; message: string }
  activeFontScanStatus: () => ActiveFontScanStatus
  isActive: () => boolean
  activeJobId: () => string
} {
  let activeFontScanJob: ActiveFontScanJob | null = null
  let latestManagedRequestId = 0
  let pendingManagedRequests = 0
  let managedScanTail: Promise<void> = Promise.resolve()

  registerCacheMaintenanceParticipant({ pause: async () => {
    cancelActiveFontScan('缓存维护优先，现有扫描已取消。')
    await managedScanTail
  } })

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
    ownerSignal?: AbortSignal,
    reuseRecoveryMetadata = false,
  ): Promise<ScanResult> {
    if (cacheMaintenancePending() && !ownsCacheMaintenance()) return Promise.resolve(cancelledScanResult(folders))
    const normalizedFolders = normalizeWatchedFontFolders(folders, deps.appendStartupLog)
    const requestId = latestManagedRequestId += 1
    pendingManagedRequests += 1
    abortActiveFontScan('新的索引扫描已开始，旧扫描已自动取消。')

    const request = managedScanTail.then(async () => {
      if (requestId !== latestManagedRequestId || ownerSignal?.aborted || (cacheMaintenancePending() && !ownsCacheMaintenance())) {
        deps.appendStartupLog(`font scan queued request superseded before start: request=${requestId}, latest=${latestManagedRequestId}`)
        return cancelledScanResult(normalizedFolders)
      }

      const jobId = createFontScanJobId()
      const controller = new AbortController()
      const abortOwner = () => controller.abort(ownerSignal?.reason)
      ownerSignal?.addEventListener('abort', abortOwner, { once: true })
      if (ownerSignal?.aborted) abortOwner()
      const startedAt = Date.now()
      const completion = scanFolders(normalizedFolders, knownFonts, { jobId, signal: controller.signal, reuseRecoveryMetadata })
      activeFontScanJob = { jobId, folders: normalizedFolders, controller, startedAt, completion }
      deps.recheckGlobalIoQueues()

      try {
        const result = await completion
        // Persistence/event/lease cleanup can finish after the last scanner
        // signal check. A retired job must not publish a fresh completion then.
        throwIfAborted(controller.signal)
        return result
      } catch (error) {
        const sharedError = error && typeof error === 'object' ? error as SharedIoProcessError : undefined
        const ownedSharedCancellation = controller.signal.aborted && sharedError?.sharedIo === true && sharedError.reason === 'cancelled'
        if (!isOperationCancelledError(error) && !ownedSharedCancellation) throw error
        // Keep the real process-close boundary before retiring this scan owner.
        if (ownedSharedCancellation && sharedError?.closed) {
          try { await sharedError.closed } catch { /* The confirmed cancellation remains the outcome. */ }
        }
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
        ownerSignal?.removeEventListener('abort', abortOwner)
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

  async function scanFoldersWhenIdle(folders: string[], signal?: AbortSignal): Promise<ScanResult> {
    if (cacheMaintenancePending()) throw new Error('source-recovery-deferred')
    const foregroundRevision = latestManagedRequestId
    await managedScanTail
    // A newer user request wins. Do not cancel it or revive a cancelled repair.
    if (signal?.aborted || isApplicationClosing()) return cancelledScanResult(folders)
    if (foregroundRevision !== latestManagedRequestId || activeFontScanJob) throw new Error('source-recovery-deferred')
    const completion = scanFoldersManaged(folders, [], signal, true)
    const recoveryRevision = latestManagedRequestId
    const result = await completion
    // A replaced background request is deferred, not a user cancellation of
    // the newer foreground request. Its result must not pause that newer root.
    if (result.stats?.cancelled && recoveryRevision !== latestManagedRequestId) throw new Error('source-recovery-deferred')
    return result
  }

  return {
    scanFoldersManaged,
    scanFoldersWhenIdle,
    cancelActiveFontScan,
    activeFontScanStatus,
    isActive: () => Boolean(activeFontScanJob) || cacheMaintenancePending(),
    activeJobId: () => activeFontScanJob?.jobId || '',
  }
}
