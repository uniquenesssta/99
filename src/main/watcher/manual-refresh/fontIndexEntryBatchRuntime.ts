import type { FontItem } from '../../../shared/types'
import type { CachedFontStatLike } from '../../fonts/fontRuntime'
import type { FontParseJob, FontParseWorkerResult } from '../../indexing/fontScanWorkers'
import type { FontScanCacheEntry, FontScanCacheFile } from '../../indexing/rootIndexRuntime'
import { consumeRustFontParseBatchFastPath } from '../../indexing/scan-orchestrator/rustParseBatchFastPathRuntime'
import { throwIfAborted } from '../../performance/ioQueue'
import { nodeFontkitScanFallbackCompatibilityAllowed } from '../../rust-core/nodeFontkitScanFallbackCompatibilityRuntime'
import type { ManualFolderRefreshDeps } from './manualFolderRefreshTypes'

export type FontIndexCacheMissReason = 'new-file' | 'size-changed' | 'modified-time-changed' | 'signature-mismatch' | 'invalid-status' | 'missing-font' | 'missing-scripts' | 'script-version' | 'concrete-event'
export type FontIndexFileInput = { file: string; freshStat: CachedFontStatLike; forceVerify?: boolean; requireSourceStability?: boolean }
export type FontIndexFileResult = { file: string; key: string; font: FontItem | null; error?: string }
export type FontIndexBatchResult = { results: FontIndexFileResult[]; misses: Partial<Record<FontIndexCacheMissReason, number>>; parsed: number }

/** Cache identity keeps the existing rounded-millisecond contract on every path. */
export function fontIndexCacheMissReason(entry: FontScanCacheEntry | undefined, signature: string, stat: CachedFontStatLike, scriptVersion: number): FontIndexCacheMissReason | null {
  if (!entry) return 'new-file'
  if (entry.cacheKey !== signature) {
    if (entry.fileSize !== stat.size) return 'size-changed'
    if (Math.round(entry.modifiedAt) !== Math.round(stat.mtimeMs)) return 'modified-time-changed'
    return 'signature-mismatch'
  }
  if (entry.status === 'bad') return null
  if (entry.status !== 'ok') return 'invalid-status'
  if (!entry.font) return 'missing-font'
  if (!Array.isArray(entry.font.scripts) || !entry.font.scripts.length) return 'missing-scripts'
  if (entry.font.scriptVersion !== scriptVersion) return 'script-version'
  return null
}

export function createFontIndexEntryBatchRuntime(deps: ManualFolderRefreshDeps) {
  return async function upsertFontIndexEntries(rootPath: string, rows: FontIndexFileInput[], cache: FontScanCacheFile, signal?: AbortSignal, assertCurrent?: () => void): Promise<FontIndexBatchResult> {
    const guard = () => { throwIfAborted(signal); assertCurrent?.() }
    guard()
    const output: FontIndexBatchResult = { results: [], misses: {}, parsed: 0 }
    const jobs: FontParseJob[] = []
    const inputs = new Map<string, { job: FontParseJob; stat: CachedFontStatLike }>()
    const completed = new Set<string>()
    for (const row of rows) {
      guard()
      const key = deps.cacheKeyForRootFile(rootPath, row.file)
      const signature = deps.fileCacheSignature(key, row.freshStat.size, row.freshStat.mtimeMs)
      const existing = cache.entries[key]
      const reason = row.forceVerify ? 'concrete-event' : fontIndexCacheMissReason(existing, signature, row.freshStat, deps.scriptDetectionVersion)
      if (!reason) {
        output.results.push({ file: row.file, key, font: existing?.status === 'ok' && existing.font ? deps.cachedFontForRuntime(existing.font, row.file, row.freshStat, key) : null })
        continue
      }
      output.misses[reason] = (output.misses[reason] || 0) + 1
      const job: FontParseJob = { requireSourceStability: row.requireSourceStability === true, jobId: `watch-${jobs.length}`, rootPath, filePath: row.file, cacheKey: key, signature,
        fileSize: row.freshStat.size, modifiedAt: row.freshStat.mtimeMs,
        createdAt: row.freshStat.birthtimeMs || row.freshStat.ctimeMs || existing?.createdAt || row.freshStat.mtimeMs }
      jobs.push(job)
      inputs.set(job.jobId, { job, stat: row.freshStat })
    }
    const accept = async (result: FontParseWorkerResult) => {
      guard()
      const input = inputs.get(result.jobId)
      if (!input || completed.has(result.jobId)) return
      const { job, stat } = input
      // Native output cannot redirect a cache row or silently change its source identity.
      if (result.filePath !== job.filePath || result.rootPath !== job.rootPath || result.cacheKey !== job.cacheKey || result.signature !== job.signature || result.fileSize !== job.fileSize || Math.round(result.modifiedAt) !== Math.round(job.modifiedAt)) {
        output.results.push({ file: job.filePath, key: job.cacheKey, font: null, error: '字体在解析期间变化，保留原索引并等待重新扫描。' })
        completed.add(job.jobId)
        return
      }
      completed.add(job.jobId)
      if (result.status === 'error' || (result.status === 'ok' && !result.font)) {
        output.results.push({ file: job.filePath, key: job.cacheKey, font: null, error: result.message || '字体解析未完成，已保留原索引。' })
        return
      }
      const cachedFont = result.status === 'ok' && result.font ? deps.sanitizeCachedFont(result.font, job.cacheKey, job.filePath, stat) : undefined
      const entry: FontScanCacheEntry = { path: job.cacheKey, cacheKey: job.signature, fileSize: job.fileSize,
        modifiedAt: job.modifiedAt, createdAt: job.createdAt, status: result.status === 'bad' ? 'bad' : 'ok',
        ...(cachedFont ? { font: cachedFont } : { message: result.message || '不是有效字体签名，已跳过。' }),
        contentHash: result.contentHash || result.quickHash, cachedAt: new Date().toISOString() }
      cache.entries[job.cacheKey] = entry
      output.parsed += 1
      output.results.push({ file: job.filePath, key: job.cacheKey, font: cachedFont ? deps.cachedFontForRuntime(cachedFont, job.filePath, stat, job.cacheKey) : null })
    }
    const rust = await consumeRustFontParseBatchFastPath({ jobs, signal, scriptDetectionVersion: deps.scriptDetectionVersion,
      runRustFontParseBatch: deps.runRustFontParseBatch, processResult: accept,
      appendStartupLog: deps.appendStartupLog, logPrefix: 'watcher selective rust parse batch' })
    guard()
    // Older/partial native results cannot authorize a watcher fallback lacking
    // pinned-source stability. Pre-existing unmarked manual callers retain it.
    const compatibilityJobs = rust.remainingJobs.filter(job => job.requireSourceStability !== true)
    if (compatibilityJobs.length && nodeFontkitScanFallbackCompatibilityAllowed() && deps.runFontParseWorkerPool) {
      await deps.runFontParseWorkerPool(compatibilityJobs, undefined, signal, accept)
      guard()
    }
    for (const job of jobs) if (!completed.has(job.jobId)) {
      output.results.push({ file: job.filePath, key: job.cacheKey, font: null, error: '字体批量解析未完成，已保留原索引。' })
    }
    return output
  }
}
