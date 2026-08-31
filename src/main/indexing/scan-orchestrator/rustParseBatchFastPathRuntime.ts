import type { FontParseJob,FontParseWorkerResult } from '../fontScanWorkers'
import { isOperationCancelledError,throwIfAborted } from '../../performance/ioQueue'
import { buildFontParseResultFromRustMetadata } from './rustMetadataFastPathRuntime'
import { nodeFontkitScanFallbackFailureLogSuffix } from '../../rust-core/nodeFontkitScanFallbackCompatibilityRuntime'

export type RustFontParseBatchRuntime = (
  jobs: FontParseJob[],
  signal?: AbortSignal,
) => Promise<{
  results: FontParseJob[]
  errors?: Array<{ jobId?: string; path?: string; message?: string }>
  count?: number
  elapsedMs?: number
} | null>

export async function consumeRustFontParseBatchFastPath(args: {
  jobs: FontParseJob[]
  signal?: AbortSignal
  scriptDetectionVersion: number
  runRustFontParseBatch?: RustFontParseBatchRuntime
  processResult: (result: FontParseWorkerResult) => Promise<void>
  appendStartupLog: (message: string) => void
  logPrefix: string
  progress?: (payload: { processed: number; total: number }) => void
  delayToEventLoop?: () => Promise<void>
}): Promise<{ remainingJobs: FontParseJob[]; consumed: number; errors: number }> {
  const {
    jobs,
    signal,
    scriptDetectionVersion,
    runRustFontParseBatch,
    processResult,
    appendStartupLog,
    logPrefix,
    progress,
    delayToEventLoop,
  } = args

  if (!jobs.length || !runRustFontParseBatch) return { remainingJobs: jobs, consumed: 0, errors: 0 }

  try {
    throwIfAborted(signal)
    const startedAt = Date.now()
    const rustResult = await runRustFontParseBatch(jobs, signal)
    throwIfAborted(signal)
    if (!rustResult || !Array.isArray(rustResult.results) || !rustResult.results.length) {
      appendStartupLog(`${logPrefix} skipped: no rust parse batch results; ${nodeFontkitScanFallbackFailureLogSuffix()}, fallbackWorker=${jobs.length}`)
      return { remainingJobs: jobs, consumed: 0, errors: rustResult?.errors?.length || 0 }
    }

    const resultByJobId = new Map<string, FontParseJob>()
    for (const result of rustResult.results) {
      if (result?.jobId) resultByJobId.set(String(result.jobId), result)
    }

    const remainingJobs: FontParseJob[] = []
    let consumed = 0
    for (const job of jobs) {
      throwIfAborted(signal)
      const rustJob = resultByJobId.get(job.jobId)
      if (!rustJob) {
        remainingJobs.push(job)
        continue
      }

      const fastResult = buildFontParseResultFromRustMetadata(rustJob, scriptDetectionVersion)
      if (!fastResult) {
        remainingJobs.push(job)
        continue
      }

      consumed += 1
      await processResult(fastResult)
      if (consumed % 200 === 0) {
        progress?.({ processed: consumed, total: jobs.length })
        await delayToEventLoop?.()
      }
    }

    appendStartupLog(`${logPrefix} used: rustBatch=${consumed}, fallbackWorker=${remainingJobs.length}, rustErrors=${rustResult.errors?.length || 0}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${rustResult.elapsedMs || 0}ms`)
    return { remainingJobs, consumed, errors: rustResult.errors?.length || 0 }
  } catch (error) {
    if (isOperationCancelledError(error)) throw error
    appendStartupLog(`${logPrefix} failed: ${error instanceof Error ? error.message : String(error)}; ${nodeFontkitScanFallbackFailureLogSuffix()}`)
    return { remainingJobs: jobs, consumed: 0, errors: 0 }
  }
}
