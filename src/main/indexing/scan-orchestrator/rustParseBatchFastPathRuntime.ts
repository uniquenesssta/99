import { rethrowSharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import type { FontParseJob,FontParseWorkerResult } from '../fontScanWorkers'
import { isOperationCancelledError,throwIfAborted } from '../../performance/ioQueue'
import { createRustMetadataRejectionReporter } from './rustMetadataDiagnosticsRuntime'
import { buildFontParseResultFromRustMetadata, rustMetadataFastPathRejectionReason } from './rustMetadataFastPathRuntime'
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
  observeMetadata?: (job: FontParseJob, identityJob: FontParseJob) => void
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

  if (!jobs.length) return { remainingJobs: jobs, consumed: 0, errors: 0 }
  if (!runRustFontParseBatch) {
    const reporter = createRustMetadataRejectionReporter(appendStartupLog, logPrefix)
    for (const job of jobs) reporter.reject(job, rustMetadataFastPathRejectionReason(job) || 'no-native-batch-runtime', job.metadataDiagnostics)
    reporter.flush()
    return { remainingJobs: jobs, consumed: 0, errors: 0 }
  }

  try {
    throwIfAborted(signal)
    const startedAt = Date.now()
    const rustResult = await runRustFontParseBatch(jobs, signal)
    throwIfAborted(signal)
    if (!rustResult || !Array.isArray(rustResult.results) || !rustResult.results.length) {
      const reporter = createRustMetadataRejectionReporter(appendStartupLog, logPrefix)
      const errorsById = new Map((rustResult?.errors || []).map(error => [error.jobId, error.message]))
      for (const job of jobs) reporter.reject(job, errorsById.has(job.jobId) ? 'native-job-error' : 'missing-native-result', undefined, errorsById.get(job.jobId))
      reporter.flush()
      appendStartupLog(`${logPrefix} skipped: no rust parse batch results; ${nodeFontkitScanFallbackFailureLogSuffix()}, fallbackWorker=${jobs.length}`)
      return { remainingJobs: jobs, consumed: 0, errors: rustResult?.errors?.length || 0 }
    }

    const resultByJobId = new Map<string, FontParseJob>()
    for (const result of rustResult.results) {
      if (result?.jobId) resultByJobId.set(String(result.jobId), result)
    }

    const rejectionReporter = createRustMetadataRejectionReporter(appendStartupLog, logPrefix)
    const errorByJobId = new Map((rustResult.errors || []).map(error => [error.jobId, error.message]))
    const remainingJobs: FontParseJob[] = []
    let consumed = 0
    let unclassifiedAsOther = 0
    for (const job of jobs) {
      throwIfAborted(signal)
      const rustJob = resultByJobId.get(job.jobId)
      if (!rustJob) {
        rejectionReporter.reject(job, errorByJobId.has(job.jobId) ? 'native-job-error' : 'missing-native-result', undefined, errorByJobId.get(job.jobId))
        remainingJobs.push(job)
        continue
      }

      args.observeMetadata?.(rustJob, job)
      const fastResult = buildFontParseResultFromRustMetadata(rustJob, scriptDetectionVersion)
      if (!fastResult) {
        rejectionReporter.reject(job, rustMetadataFastPathRejectionReason(rustJob) || 'unusable-metadata', rustJob.metadataDiagnostics)
        remainingJobs.push({ ...job, ...rustJob })
        continue
      }

      if (!rustJob.scriptHint && fastResult.font?.scripts.includes('other')) unclassifiedAsOther++
      consumed += 1
      await processResult(fastResult)
      if (consumed % 200 === 0) {
        progress?.({ processed: consumed, total: jobs.length })
        await delayToEventLoop?.()
      }
    }

    rejectionReporter.flush()
    appendStartupLog(`${logPrefix} used: rustBatch=${consumed}, unclassifiedAsOther=${unclassifiedAsOther}, fallbackWorker=${remainingJobs.length}, rustErrors=${rustResult.errors?.length || 0}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${rustResult.elapsedMs || 0}ms`)
    return { remainingJobs, consumed, errors: rustResult.errors?.length || 0 }
  } catch (error) {
      rethrowSharedIoProcessError(error)
    if (isOperationCancelledError(error)) throw error
    appendStartupLog(`${logPrefix} failed: ${error instanceof Error ? error.message : String(error)}; ${nodeFontkitScanFallbackFailureLogSuffix()}`)
    return { remainingJobs: jobs, consumed: 0, errors: 0 }
  }
}
