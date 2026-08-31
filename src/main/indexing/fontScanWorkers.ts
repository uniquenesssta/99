import fs,{ promises as fsp } from 'node:fs'
import { dirname,extname,join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { FontItem } from '../../shared/types'
import type { CachedFontStatLike } from '../fonts/fontRuntime'
import { OperationCancelledError,abortMessage,isOperationCancelledError,throwIfAborted } from '../performance/ioQueue'
import { storageProfileSummary,type StorageProfile } from '../performance/storageProfile'

export interface RustFontScriptHint {
  scripts?: string[]
  rangeCount?: number
  sourceIndex?: number
}

export interface RustFontStyleHint {
  weightClass?: number
  widthClass?: number
  italic?: boolean
  bold?: boolean
  monospaced?: boolean
  unitsPerEm?: number
  glyphCount?: number
  sourceIndex?: number
}


export interface RustFontFamilyHint {
  familyName?: string
  styleName?: string
  familyKey?: string
  styleKey?: string
  weightClass?: number
  widthClass?: number
  italic?: boolean
  bold?: boolean
  monospaced?: boolean
  sourceIndex?: number
}

export interface RustFontNameHint {
  familyName?: string
  subfamilyName?: string
  fullName?: string
  postscriptName?: string
  preferredFamily?: string
  preferredSubfamily?: string
  displayFamily?: string
  displaySubfamily?: string
  version?: string
  manufacturer?: string
  recordCount?: number
  sourceIndex?: number
}

export interface FontParseJob {
  jobId: string
  rootPath: string
  filePath: string
  fileSize: number
  modifiedAt: number
  createdAt: number
  cacheKey: string
  signature: string
  signatureValid?: boolean
  formatHint?: string
  quickHash?: string
  contentHash?: string
  hashKind?: string
  nameHint?: RustFontNameHint
  scriptHint?: RustFontScriptHint
  styleHint?: RustFontStyleHint
  familyHint?: RustFontFamilyHint
}

export interface FontParseWorkerResult {
  jobId: string
  rootPath: string
  filePath: string
  cacheKey: string
  signature: string
  fileSize: number
  modifiedAt: number
  createdAt: number
  status: 'ok' | 'bad' | 'error'
  quickHash?: string
  contentHash?: string
  hashKind?: string
  font?: FontItem
  message?: string
}

interface FontIndexListedFile {
  file: string
  rootPath: string
  stat: CachedFontStatLike
}

export interface FontIndexListWorkerDoneMessage {
  type: 'done'
  files: FontIndexListedFile[]
  errors: Array<{ path: string; message: string }>
  foldersScanned: number
}

interface FontIndexListWorkerProgressMessage {
  type: 'progress'
  files: number
  foldersScanned: number
  batch?: FontIndexListedFile[]
}

type FontIndexListWorkerMessage = FontIndexListWorkerDoneMessage | FontIndexListWorkerProgressMessage
type FontParseWorkerPoolProgress = { done: number; total: number; workerCount: number }
type FontParseWorkerMessage = FontParseWorkerResult | { type: 'batch'; results: FontParseWorkerResult[] }

export interface FontScanWorkersDeps {
  dataPath: (...segments: string[]) => string
  scanWorkerVersion: string
  scanWorkerBatchSize: number
  fontExtensions: Set<string>
  indexListWorkerSource: () => string
  scanWorkerSource: () => string
  fontkitPath: () => string
  storageProfileForPath: (filePath: string) => StorageProfile
  scanWorkerCount: (jobCount: number, roots: string[]) => number
  appendStartupLog: (line: string) => void
}

export function createFontScanWorkers(deps: FontScanWorkersDeps) {
  async function listFontFiles(folder: string, errors: Array<{ path: string; message: string }>): Promise<string[]> {
    const result: string[] = []

    async function walk(dir: string): Promise<void> {
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch (error) {
        if (isOperationCancelledError(error)) throw error
        errors.push({ path: dir, message: error instanceof Error ? error.message : String(error) })
        return
      }

      for (const entry of entries) {
        const full = join(dir, entry.name)

        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
          await walk(full)
        } else if (entry.isFile() && deps.fontExtensions.has(extname(entry.name).toLowerCase())) {
          if (entry.name.startsWith('._')) continue
          result.push(full)
        }
      }
    }

    await walk(folder)
    return result
  }

  async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
    if (!items.length) return []

    const results = new Array<R>(items.length)
    let nextIndex = 0

    async function worker(): Promise<void> {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(items[index], index)
      }
    }

    const workerCount = Math.max(1, Math.min(concurrency, items.length))
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
    return results
  }

  function indexListWorkerPath(): string {
    return deps.dataPath('runtime', `font-index-list-worker-${deps.scanWorkerVersion}.cjs`)
  }

  async function ensureIndexListWorkerScript(): Promise<string> {
    const filePath = indexListWorkerPath()
    await fsp.mkdir(dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, deps.indexListWorkerSource(), 'utf-8')
    return filePath
  }

  async function runFontIndexListWorker(folders: string[], progress?: (payload: { files: number; foldersScanned: number; batch?: FontIndexListedFile[] }) => void, signal?: AbortSignal): Promise<FontIndexListWorkerDoneMessage> {
    throwIfAborted(signal)
    const scriptPath = await ensureIndexListWorkerScript()

    return await new Promise<FontIndexListWorkerDoneMessage>((resolveWorker, rejectWorker) => {
      let settled = false
      const worker = new Worker(scriptPath, {
        workerData: {
          folders,
          extensions: Array.from(deps.fontExtensions)
        }
      })

      const settleRejected = (error: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        worker.terminate().catch(() => undefined)
        rejectWorker(error)
      }

      const abort = (): void => {
        settleRejected(new OperationCancelledError(abortMessage(signal)))
      }

      signal?.addEventListener('abort', abort, { once: true })

      worker.on('message', (message: FontIndexListWorkerMessage) => {
        if (settled) return
        if (message.type === 'progress') {
          progress?.({ files: message.files, foldersScanned: message.foldersScanned, batch: message.batch })
          return
        }

        settled = true
        signal?.removeEventListener('abort', abort)
        resolveWorker(message)
        worker.terminate().catch(() => undefined)
      })

      worker.on('error', (error) => {
        settleRejected(error)
      })

      worker.on('exit', (code) => {
        if (settled) return
        settleRejected(new Error(`索引列表 Worker 在返回完成结果前退出：${code}`))
      })
    })
  }

  function scanWorkerPath(): string {
    return deps.dataPath('runtime', `font-scan-worker-${deps.scanWorkerVersion}.cjs`)
  }

  async function ensureScanWorkerScript(): Promise<string> {
    const filePath = scanWorkerPath()
    await fsp.mkdir(dirname(filePath), { recursive: true })
    await fsp.writeFile(filePath, deps.scanWorkerSource(), 'utf-8')
    return filePath
  }

  async function runFontParseWorkerPool(
    jobs: FontParseJob[],
    progress?: (payload: FontParseWorkerPoolProgress) => void,
    signal?: AbortSignal,
    onResult?: (result: FontParseWorkerResult) => Promise<void> | void
  ): Promise<{ workerCount: number }> {
    throwIfAborted(signal)
    if (!jobs.length) return { workerCount: 0 }

    const roots = Array.from(new Set(jobs.map((job) => job.rootPath)))
    const storageProfiles = roots.map(deps.storageProfileForPath)
    const workerCount = deps.scanWorkerCount(jobs.length, roots)
    const batchSize = Math.max(1, Math.min(deps.scanWorkerBatchSize, Math.ceil(jobs.length / workerCount)))
    const scriptPath = await ensureScanWorkerScript()
    const fontkitPath = deps.fontkitPath()

    let nextJobIndex = 0
    let finished = 0

    await new Promise<void>((resolvePool, rejectPool) => {
      type ParseWorkerState = {
        jobs: FontParseJob[]
        failed: boolean
      }

      const workers = new Set<Worker>()
      let settled = false

      const rejectOnce = (error: unknown): void => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', abort)
        for (const worker of workers) worker.terminate().catch(() => undefined)
        workers.clear()
        rejectPool(error)
      }

      const abort = (): void => {
        rejectOnce(new OperationCancelledError(abortMessage(signal)))
      }

      signal?.addEventListener('abort', abort, { once: true })

      const finishResult = async (result: FontParseWorkerResult): Promise<void> => {
        if (settled) return
        await onResult?.(result)
        if (settled) return
        finished += 1
        progress?.({ done: finished, total: jobs.length, workerCount })
        if (finished >= jobs.length) {
          settled = true
          signal?.removeEventListener('abort', abort)
          for (const worker of workers) worker.terminate().catch(() => undefined)
          workers.clear()
          resolvePool()
        }
      }

      const assign = (worker: Worker, state: ParseWorkerState): void => {
        if (settled || state.failed || signal?.aborted) return
        if (nextJobIndex >= jobs.length) return
        const batch = jobs.slice(nextJobIndex, Math.min(jobs.length, nextJobIndex + batchSize))
        nextJobIndex += batch.length
        state.jobs = batch
        worker.postMessage(batch.length === 1 ? { type: 'parse', job: batch[0] } : { type: 'parseBatch', jobs: batch })
      }

      const normalizeMessageResults = (message: FontParseWorkerMessage): FontParseWorkerResult[] => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'batch') {
          return Array.isArray(message.results) ? message.results : []
        }
        return [message as FontParseWorkerResult]
      }

      const startWorker = (): void => {
        if (settled || signal?.aborted || finished >= jobs.length || nextJobIndex >= jobs.length) return
        const state: ParseWorkerState = { jobs: [], failed: false }
        const worker = new Worker(scriptPath, { workerData: { fontkitPath } })
        workers.add(worker)
        installHandlers(worker, state)
        assign(worker, state)
      }

      const handleWorkerFailure = (worker: Worker, state: ParseWorkerState, message: string): void => {
        if (settled || state.failed) return
        state.failed = true
        workers.delete(worker)
        worker.terminate().catch(() => undefined)
        const failedJobs = state.jobs.splice(0, state.jobs.length)
        ;(async () => {
          for (const job of failedJobs) {
            await finishResult({
              ...job,
              status: 'error',
              message
            })
          }
          startWorker()
        })().catch(rejectOnce)
      }

      const installHandlers = (worker: Worker, state: ParseWorkerState): void => {
        worker.on('message', (message: FontParseWorkerMessage) => {
          if (settled || state.failed) return
          const received = normalizeMessageResults(message)
          const fallbackJobs = state.jobs.splice(0, state.jobs.length)
          ;(async () => {
            const receivedByJobId = new Map(received.map((result) => [result.jobId, result]))
            const results = fallbackJobs.map((job) => receivedByJobId.get(job.jobId) || {
              ...job,
              status: 'error' as const,
              message: received.length ? 'Worker 返回的批量结果不完整。' : 'Worker 返回空结果。'
            })
            for (const result of results) await finishResult(result)
            assign(worker, state)
          })().catch(rejectOnce)
        })

        worker.on('error', (error) => {
          handleWorkerFailure(worker, state, error instanceof Error ? error.message : String(error))
        })

        worker.on('exit', (code) => {
          if (settled || state.failed) return
          handleWorkerFailure(worker, state, `索引解析 Worker 在任务完成前退出：${code}`)
        })
      }

      deps.appendStartupLog(`scan worker pool started: jobs=${jobs.length}, workers=${workerCount}, batchSize=${batchSize}, roots=${roots.length}, profiles=${storageProfileSummary(storageProfiles)}`)
      for (let index = 0; index < workerCount; index += 1) startWorker()
    })

    return { workerCount }
  }

  return { listFontFiles, mapWithConcurrency, runFontIndexListWorker, runFontParseWorkerPool }
}
