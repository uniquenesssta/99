import type { FontItem,ScanResult } from '../../shared/types'
import { fileCacheSignature } from '../cache/cachePaths'
import { normalizePathForCacheCompare } from '../path/cachePath'
import type { CachedFontStatLike } from '../fonts/fontRuntime'
import { throwIfAborted } from '../performance/ioQueue'
import {
  logNodeFontkitScanFallbackDisabled,
  logNodeFontkitScanFallbackUsed,
  nodeFontkitScanFallbackCompatibilityAllowed,
} from '../rust-core/nodeFontkitScanFallbackCompatibilityRuntime'
import type { FontParseJob,FontParseWorkerResult } from './fontScanWorkers'
import { createFontIndexProgressReporter } from './scan-orchestrator/fontIndexProgressRuntime'
import { normalizeScanContentHash,withScanContentHash } from './scan-orchestrator/scanContentHashRuntime'
import { buildFontParseResultFromRustMetadata } from './scan-orchestrator/rustMetadataFastPathRuntime'
import { consumeRustFontParseBatchFastPath } from './scan-orchestrator/rustParseBatchFastPathRuntime'
import { createFontScanActiveJobRuntime } from './scan-orchestrator/fontScanActiveJobRuntime'
import { createFontScanHashBufferRuntime } from './scan-orchestrator/fontScanHashBufferRuntime'
import { createFontScanIncrementalChangeRuntime } from './scan-orchestrator/fontScanIncrementalChangeRuntime'
import { createFontScanEarlyVisibleRuntime } from './scan-orchestrator/fontScanEarlyVisibleRuntime'
import { createScanIncrementalDecisionRuntime } from './scan-orchestrator/scanIncrementalDecisionRuntime'
import { createRootDirectoryCacheRuntime } from './scan-orchestrator/rootDirectoryCacheRuntime'
import type { ScanOrchestratorDeps,ScanOrchestratorRuntime } from './scan-orchestrator/scanOrchestratorTypes'
import { createFontScanJobId,delayToEventLoop } from './scan-orchestrator/scanOrchestratorUtils'
import { createScanRootCacheContextRuntime } from './scan-orchestrator/scanRootCacheContextRuntime'
import { ensureRootContextsForScan,listScanStatJobs,normalizeScanFolders,type ScanStatJob } from './scan-orchestrator/scanListingRuntime'
import { writeRootScanCacheContexts } from './scan-orchestrator/scanRootCacheWriteRuntime'
import { createSharedIndexLeaseRuntime } from './root-index/sharedIndexLeaseRuntime'

export type { ActiveFontScanStatus,ScanOrchestratorDeps,ScanOrchestratorRuntime } from './scan-orchestrator/scanOrchestratorTypes'

export function createScanOrchestrator(deps: ScanOrchestratorDeps): ScanOrchestratorRuntime {
  const directoryCacheRuntime = createRootDirectoryCacheRuntime(deps)
  const sharedIndexLeaseRuntime = createSharedIndexLeaseRuntime({ appendStartupLog: deps.appendStartupLog })

  async function scanFolders(
    folders: string[],
    knownFonts: FontItem[] = [],
    options: { jobId?: string; signal?: AbortSignal } = {},
  ): Promise<ScanResult> {
    const startedAt = Date.now()
    const errors: ScanResult['errors'] = []
    const hashRuntime = createFontScanHashBufferRuntime(deps)
    const { queueHashFont, flushHashBuffer } = hashRuntime

    const rootCacheRuntime = createScanRootCacheContextRuntime(deps)
    const { ensureRootContext, ensureLegacyCacheLoaded, rememberEntry, rootCacheContexts } = rootCacheRuntime
    let totalFiles = 0
    let parsed = 0
    let fromCache = 0
    let reusedKnown = 0
    let skippedBad = 0
    let workerCount = 0

    const normalizedFolders = normalizeScanFolders(folders)
    const jobId = options.jobId || createFontScanJobId()
    const signal = options.signal
    const reportProgress = createFontIndexProgressReporter(deps, jobId, normalizedFolders)
    const incrementalChanges = createFontScanIncrementalChangeRuntime({
      jobId,
      batchSizes: [10, 50, 100, 200],
      signal,
      sendFontIndexChanged: deps.sendFontIndexChanged,
      appendStartupLog: deps.appendStartupLog,
    })
    const earlyVisibleRuntime = createFontScanEarlyVisibleRuntime({
      cacheKeyForRootFile: deps.cacheKeyForRootFile,
      cachedFontForRuntime: deps.cachedFontForRuntime,
      incrementalChanges,
      appendStartupLog: deps.appendStartupLog,
    })

    reportProgress({ stage: 'start', message: '正在启动后台索引 Worker……' }, true)
    throwIfAborted(signal)

    await ensureRootContextsForScan({
      deps,
      folders: normalizedFolders,
      signal,
      errors,
      ensureRootContext,
    })

    const leaseResult = await sharedIndexLeaseRuntime.acquireForContexts(rootCacheContexts.values(), jobId)
    const scanFoldersForWork = normalizedFolders.filter((folder) => !leaseResult.busyRootKeys.has(normalizePathForCacheCompare(folder)))
    const writableRootCacheContexts = () => Array.from(rootCacheContexts.values()).filter((context) => !leaseResult.busyRootKeys.has(normalizePathForCacheCompare(context.rootPath)))
    if (leaseResult.busyRoots.length) {
      deps.appendStartupLog(`scan shared index build lease skipped roots=${leaseResult.busyRoots.length}, jobId=${jobId}, roots=${leaseResult.busyRoots.join('|')}`)
      reportProgress({ stage: 'start', message: `其他电脑正在更新 ${leaseResult.busyRoots.length} 个共享索引，本机跳过重复扫描。`, totalFiles: 0 }, true)
    }

    if (!scanFoldersForWork.length) {
      incrementalChanges.dispose()
      await sharedIndexLeaseRuntime.releaseAll(leaseResult.acquired)
      const durationMs = Date.now() - startedAt
      reportProgress({
        stage: 'done',
        message: `索引更新已跳过：其他电脑正在构建共享索引，用时 ${Math.round(durationMs / 1000)} 秒。`,
        totalFiles: 0,
        parsedFiles: 0,
        fromCache: 0,
        reusedKnown: 0,
        skippedBad: 0,
        workerCount: 0,
        durationMs,
        errors: errors.length,
      }, true)
      await deps.recordCacheEvent('scan', 'scan_skipped_shared_index_lease', {
        folders: normalizedFolders,
        busyRoots: leaseResult.busyRoots,
        errors: errors.length,
        durationMs,
      })
      return {
        folders: normalizedFolders,
        fonts: [],
        errors,
        stats: {
          totalFiles: 0,
          parsed: 0,
          fromCache: 0,
          reusedKnown: 0,
          skippedBad: 0,
          errors: errors.length,
          durationMs,
          workerCount: 0,
          queuedForWorkers: 0,
        },
      }
    }

    try {
          let parsedStatJobs: ScanStatJob[] = await listScanStatJobs({
            deps,
            directoryCacheRuntime,
            folders: scanFoldersForWork,
            signal,
            errors,
            ensureRootContext,
            reportProgress,
            onListedBatch: earlyVisibleRuntime.enqueueListedBatch,
          })

          totalFiles = parsedStatJobs.length
          if (totalFiles <= 100) incrementalChanges.flush(true)
          else incrementalChanges.flush()
          if (earlyVisibleRuntime.emittedCount() > 0) {
            deps.appendStartupLog(`scan early visible stream emitted: fonts=${earlyVisibleRuntime.emittedCount()}, capped=${earlyVisibleRuntime.cappedCount()}, jobId=${jobId}`)
          }
          reportProgress({ stage: 'evaluating', message: `正在对比索引：${totalFiles} 个字体文件。`, totalFiles, listedFiles: totalFiles }, true)

          const parseJobs: FontParseJob[] = []
          const manifestDecisions = createScanIncrementalDecisionRuntime({
            deps,
            knownFonts,
            ensureLegacyCacheLoaded,
          })
          const parseDecisionReasons = new Map<string, number>()
          const manifestReuseSources = new Map<string, number>()
          let evaluatedFiles = 0

          function bumpCounter(map: Map<string, number>, key: string): void {
            map.set(key, (map.get(key) || 0) + 1)
          }

          function formatCounter(map: Map<string, number>): string {
            return Array.from(map.entries())
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([key, value]) => `${key}:${value}`)
              .join(',') || 'none'
          }

          function countManifestDeletes(): number {
            let deleted = 0
            for (const context of writableRootCacheContexts()) {
              for (const key of Object.keys(context.cache.entries || {})) {
                if (!context.seenKeys.has(key)) deleted += 1
              }
            }
            return deleted
          }

          for (const item of parsedStatJobs) {
            throwIfAborted(signal)
            evaluatedFiles += 1
            if (evaluatedFiles % 500 === 0) {
              reportProgress({
                stage: 'evaluating',
                message: `正在对比索引：${evaluatedFiles}/${totalFiles}，复用 ${fromCache + reusedKnown}，待解析 ${parseJobs.length}。`,
                totalFiles,
                stattedFiles: evaluatedFiles,
                fromCache,
                reusedKnown,
                skippedBad,
              })
              incrementalChanges.flush()
              await delayToEventLoop()
            }

            if (!item.stat) {
              errors.push({ path: item.file, message: item.error || '读取文件状态失败。' })
              continue
            }

            const file = item.file
            const rootPath = item.rootPath
            const stat = item.stat
            const createdAt = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs
            const context = await ensureRootContext(rootPath)
            const rootCacheKey = deps.cacheKeyForRootFile(rootPath, file)
            const signature = fileCacheSignature(rootCacheKey, stat.size, stat.mtimeMs)
            const contentHash = normalizeScanContentHash(item.contentHash || item.quickHash)
            context.seenKeys.add(rootCacheKey)

            const decision = await manifestDecisions.decide({
              item,
              file,
              rootPath,
              stat,
              createdAt,
              rootCacheKey,
              signature,
              contentHash,
              cached: context.cache.entries[rootCacheKey],
            })

            if (decision.action === 'skip-bad') {
              skippedBad += 1
              bumpCounter(manifestReuseSources, decision.source)
              rememberEntry(context, rootCacheKey, decision.entry)
              continue
            }

            if (decision.action === 'reuse-font') {
              if (decision.source === 'known') reusedKnown += 1
              else fromCache += 1
              bumpCounter(manifestReuseSources, decision.source)
              await queueHashFont(decision.font)
              incrementalChanges.enqueueUpsert(rootPath, decision.font)
              rememberEntry(context, rootCacheKey, decision.entry)
              continue
            }

            bumpCounter(parseDecisionReasons, decision.reason)
            parseJobs.push({
              ...decision.job,
              jobId: `${parseJobs.length}`,
            })

          }

          deps.appendStartupLog(`scan incremental manifest decision: total=${totalFiles}, reusedKnown=${reusedKnown}, reusedCache=${fromCache}, skippedBad=${skippedBad}, parseQueued=${parseJobs.length}, deleteCandidates=${countManifestDeletes()}, reuseSources=${formatCounter(manifestReuseSources)}, parseReasons=${formatCounter(parseDecisionReasons)}`)

          reportProgress({
            stage: 'parsing',
            message: parseJobs.length ? `后台 Worker 正在解析新增/变更字体：0/${parseJobs.length}。` : '没有新增或变更字体需要解析。',
            totalFiles,
            parsedFiles: 0,
            fromCache,
            reusedKnown,
            skippedBad,
            workerCount: deps.scanWorkerCount(parseJobs.length, scanFoldersForWork),
          }, true)

          throwIfAborted(signal)
          let processedWorkerResults = 0
          const processWorkerResult = async (result: FontParseWorkerResult): Promise<void> => {
            throwIfAborted(signal)
            processedWorkerResults += 1
            if (processedWorkerResults % 500 === 0) await delayToEventLoop()
            const context = await ensureRootContext(result.rootPath)

            if (result.status === 'bad') {
              skippedBad += 1
              rememberEntry(context, result.cacheKey, withScanContentHash({
                path: result.cacheKey,
                cacheKey: result.signature,
                fileSize: result.fileSize,
                modifiedAt: result.modifiedAt,
                createdAt: result.createdAt,
                status: 'bad',
                message: result.message || '不是有效字体签名，已跳过。',
                cachedAt: new Date().toISOString(),
              }, normalizeScanContentHash(result.contentHash || result.quickHash)))
              return
            }

            if (result.status === 'error' || !result.font) {
              const message = result.message || 'Worker 解析失败。'
              skippedBad += 1
              errors.push({ path: result.filePath, message })
              rememberEntry(context, result.cacheKey, withScanContentHash({
                path: result.cacheKey,
                cacheKey: result.signature,
                fileSize: result.fileSize,
                modifiedAt: result.modifiedAt,
                createdAt: result.createdAt,
                status: 'bad',
                message,
                cachedAt: new Date().toISOString(),
              }, normalizeScanContentHash(result.contentHash || result.quickHash)))
              return
            }

            parsed += 1
            await queueHashFont(result.font)
            incrementalChanges.enqueueUpsert(result.rootPath, result.font)
            rememberEntry(context, result.cacheKey, withScanContentHash({
              path: result.cacheKey,
              cacheKey: result.signature,
              fileSize: result.fileSize,
              modifiedAt: result.modifiedAt,
              createdAt: result.createdAt,
              status: 'ok',
              font: deps.sanitizeCachedFont(result.font, result.cacheKey, result.filePath, {
                size: result.fileSize,
                mtimeMs: result.modifiedAt,
                birthtimeMs: result.createdAt,
                ctimeMs: result.createdAt,
              }),
              cachedAt: new Date().toISOString(),
            }, normalizeScanContentHash(result.contentHash || result.quickHash)))
          }

          const workerParseJobs: FontParseJob[] = []
          let rustFastPathParsed = 0
          for (const job of parseJobs) {
            throwIfAborted(signal)
            const fastResult = buildFontParseResultFromRustMetadata(job, deps.scriptDetectionVersion)
            if (fastResult) {
              rustFastPathParsed += 1
              await processWorkerResult(fastResult)
              if (rustFastPathParsed % 200 === 0) {
                reportProgress({
                  stage: 'parsing',
                  message: `Rust 元数据快速整理：${processedWorkerResults}/${parseJobs.length}。`,
                  totalFiles,
                  parsedFiles: processedWorkerResults,
                  fromCache,
                  reusedKnown,
                  skippedBad,
                  workerCount: 0,
                })
                await delayToEventLoop()
              }
              continue
            }
            workerParseJobs.push(job)
          }

          if (rustFastPathParsed > 0) {
            deps.appendStartupLog(`rust metadata parse fast path used: fast=${rustFastPathParsed}, fallbackWorker=${workerParseJobs.length}`)
          }

          const rustBatch = await consumeRustFontParseBatchFastPath({
            jobs: workerParseJobs,
            signal,
            scriptDetectionVersion: deps.scriptDetectionVersion,
            runRustFontParseBatch: deps.runRustFontParseBatch,
            processResult: processWorkerResult,
            appendStartupLog: deps.appendStartupLog,
            logPrefix: 'scan rust parse batch fast path',
            progress: () => {
              reportProgress({
                stage: 'parsing',
                message: `Rust 批量解析新增/变更字体：${processedWorkerResults}/${parseJobs.length}。`,
                totalFiles,
                parsedFiles: processedWorkerResults,
                fromCache,
                reusedKnown,
                skippedBad,
                workerCount: 0,
              })
            },
            delayToEventLoop,
          })

          if (rustBatch.remainingJobs.length && !nodeFontkitScanFallbackCompatibilityAllowed()) {
            logNodeFontkitScanFallbackDisabled({
              appendStartupLog: deps.appendStartupLog,
              source: 'scan-fontkit-worker',
              unresolved: rustBatch.remainingJobs.length,
            })
            for (const job of rustBatch.remainingJobs) {
              await processWorkerResult({
                ...job,
                status: 'error',
                message: 'Rust 扫描解析未能完整识别；Node/fontkit 兜底已按 Rust 全量迁移策略禁用。',
              })
            }
            workerCount = 0
          } else {
            if (rustBatch.remainingJobs.length) {
              logNodeFontkitScanFallbackUsed({
                appendStartupLog: deps.appendStartupLog,
                source: 'scan-fontkit-worker',
                unresolved: rustBatch.remainingJobs.length,
              })
            }
            const workerResult = await deps.runFontParseWorkerPool(
              rustBatch.remainingJobs,
              (payload) => {
                reportProgress({
                  stage: 'parsing',
                  message: `后台 Worker 正在解析新增/变更字体：${processedWorkerResults}/${parseJobs.length}。`,
                  totalFiles,
                  parsedFiles: processedWorkerResults,
                  fromCache,
                  reusedKnown,
                  skippedBad,
                  workerCount: payload.workerCount,
                })
              },
              signal,
              processWorkerResult,
            )
            workerCount = workerResult.workerCount
          }
          incrementalChanges.flush(true)
          if (incrementalChanges.emittedCount() > 0) {
            deps.appendStartupLog(`scan incremental font-index stream emitted: fonts=${incrementalChanges.emittedCount()}, jobId=${jobId}`)
          }
          await flushHashBuffer()

          reportProgress({
            stage: 'writing',
            message: `正在分批写入 SQLite 索引：${writableRootCacheContexts().length} 个索引库。`,
            totalFiles,
            parsedFiles: parsed,
            fromCache,
            reusedKnown,
            skippedBad,
            workerCount,
          }, true)

          throwIfAborted(signal)
          await writeRootScanCacheContexts(deps, directoryCacheRuntime, writableRootCacheContexts())

          const durationMs = Date.now() - startedAt
          reportProgress({
            stage: 'done',
            message: `索引更新完成：${totalFiles} 个字体，复用 ${fromCache + reusedKnown} 个，新解析 ${parsed} 个，用时 ${Math.round(durationMs / 1000)} 秒。`,
            totalFiles,
            parsedFiles: parsed,
            fromCache,
            reusedKnown,
            skippedBad,
            workerCount,
            durationMs,
            errors: errors.length,
          }, true)

          deps.appendStartupLog(`scanFolders finished: total=${totalFiles}, known=${reusedKnown}, cache=${fromCache}, parsed=${parsed}, skipped=${skippedBad}, workers=${workerCount}, rootIndexDbs=${writableRootCacheContexts().length}, hashFlushes=${hashRuntime.getHashFlushes()}, durationMs=${durationMs}`)
          throwIfAborted(signal)
          await flushHashBuffer()
          await deps.recordCacheEvent('scan', 'scan_finished', {
            folders: scanFoldersForWork,
            totalFiles,
            parsed,
            fromCache,
            reusedKnown,
            skippedBad,
            errors: errors.length,
            durationMs,
          })

          return {
            folders: scanFoldersForWork,
            fonts: [],
            errors,
            stats: {
              totalFiles,
              parsed,
              fromCache,
              reusedKnown,
              skippedBad,
              errors: errors.length,
              durationMs: Date.now() - startedAt,
              workerCount,
              queuedForWorkers: parseJobs.length,
            },
          }
    } finally {
      incrementalChanges.dispose()
      await sharedIndexLeaseRuntime.releaseAll(leaseResult.acquired)
    }

  }



  const activeJobRuntime = createFontScanActiveJobRuntime(deps, scanFolders)

  return {
    scanFolders,
    ...activeJobRuntime,
    readRootDirectorySignatures: directoryCacheRuntime.readRootDirectorySignatures,
    saveRootDirectorySignatures: directoryCacheRuntime.saveRootDirectorySignatures,
    relativeDirectoryPathForRoot: directoryCacheRuntime.relativeDirectoryPathForRoot,
    cacheKeyInsideDirectory: directoryCacheRuntime.cacheKeyInsideDirectory,
    listFontFilesWithDirectoryCache: directoryCacheRuntime.listFontFilesWithDirectoryCache,
  }
}
