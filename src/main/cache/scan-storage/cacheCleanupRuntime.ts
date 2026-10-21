import { runCacheMaintenance } from '../../maintenance/cacheMaintenanceCoordinator'
import { executeSharedFile, sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { awaitPhysicalIoClose } from '../../path/ioDeadlineRuntime'
import { dirname, join, resolve } from 'node:path'
import type { CacheStats } from '../../../shared/types'
import { requestRootIndexRebuild } from '../../indexing/root-index/rootIndexRebuildRequestRuntime'
import {
  ROOT_CACHE_LOCK_DIR_NAME,
} from '../constants'
import { withCacheCleanupLocks, type CacheCleanupOutcome } from './cacheCleanupLeaseRuntime'
import type { ScanCacheStatsReader, ScanCacheStorageRuntimeOptions } from './scanCacheStorageTypes'

type CleanupReport = { removed: number; missing: number; failures: string[] }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }

export function createCacheCleanupRuntime(options: ScanCacheStorageRuntimeOptions, deps: { getCacheStats: ScanCacheStatsReader; invalidateCacheStats: () => void }) {
  const log = (value: string): void => { try { options.appendStartupLog(value) } catch { /* A logging failure cannot rewrite cleanup outcomes. */ } }
  function consume(report: CleanupReport, outcomes: CacheCleanupOutcome[]): void {
    for (const row of outcomes) {
      if (row.status === 'removed') report.removed += 1
      else if (row.status === 'missing') report.missing += 1
      else report.failures.push(`${row.path}: ${row.message || '删除未确认'}`)
    }
  }
  async function attempt(report: CleanupReport, target: string, action: () => Promise<void>): Promise<void> {
    try { await action() }
    catch (error) { await awaitPhysicalIoClose(error); report.failures.push(`${target}: ${message(error)}`) }
  }
  async function present(path: string): Promise<boolean> {
    try { await fsp.stat(path); return true }
    catch (error) { if (missing(error)) return false; throw error }
  }
  async function watchedFolders(report: CleanupReport): Promise<string[]> {
    try { return [...new Set(((await options.loadLibraryShell()).folders || []).filter(Boolean).map(folder => resolve(folder)))] }
    catch (error) { await awaitPhysicalIoClose(error); report.failures.push(`读取字体根目录失败: ${message(error)}`); return [] }
  }
  async function finish(report: CleanupReport): Promise<CacheStats> {
    log(`cache cleanup finished: removed=${report.removed}, missing=${report.missing}, failed=${report.failures.length}`)
    if (report.failures.length) throw new Error(`缓存清理未全部完成：已清理 ${report.removed} 个缓存项，${report.missing} 个已不存在，${report.failures.length} 项保留或未确认。${report.failures.slice(0, 4).join('；')}${report.failures.length > 4 ? '；其余详情见日志。' : ''}`)
    return deps.getCacheStats()
  }
  function enqueue(action: (report: CleanupReport) => Promise<void>): Promise<CacheStats> {
    return runCacheMaintenance(async () => {
      const report: CleanupReport = { removed: 0, missing: 0, failures: [] }
      deps.invalidateCacheStats()
      try { await action(report) }
      finally { deps.invalidateCacheStats() }
      for (const failure of report.failures) log(`cache cleanup retained: ${failure}`)
      return finish(report)
    })
  }

  async function clearIndexGroup(report: CleanupReport, cacheDir: string, jsonPaths: string[]): Promise<void> {
    if (!await present(cacheDir)) { report.missing += 1; return }
    const lockPaths = [join(cacheDir, ROOT_CACHE_LOCK_DIR_NAME, 'cache-cleanup.lock')]
    await withCacheCleanupLocks(lockPaths, async remove => {
      // Invalidate parse reuse, not the last usable source. The request survives
      // cancellation/restart; the complete replacement writer acknowledges it.
      const requestId = await requestRootIndexRebuild(cacheDir)
      consume(report, await remove(jsonPaths))
      log(`scan cache rebuild requested: cacheDir=${cacheDir}, requestId=${requestId}; active index retained until replacement commits`)
    }, log)
  }

  function clearScanCache(): Promise<CacheStats> {
    return enqueue(async report => {
      const legacy = options.legacyScanCachePath()
      await attempt(report, legacy, async () => {
        if (!await present(legacy)) { report.missing += 1; return }
        await withCacheCleanupLocks([join(dirname(legacy), 'cache-cleanup.lock')], async remove => {
          consume(report, await remove([legacy]))
        }, log)
      })
      for (const folder of await watchedFolders(report)) {
        await attempt(report, folder, () => clearIndexGroup(report, options.rootCacheDir(folder), [options.rootScanCachePath(folder), options.rootLegacyScanCachePath(folder)]))
        await attempt(report, options.fallbackCacheRootDir(folder), () => clearIndexGroup(report, options.fallbackCacheRootDir(folder), [options.fallbackScanCachePath(folder), options.fallbackLegacyScanCachePath(folder)]))
      }
    })
  }

  async function clearPreviewGroup(report: CleanupReport, cacheDir: string, imageDir: string, dbPath: string): Promise<void> {
    const hasDatabase = await present(dbPath)
    if (!await present(cacheDir)) {
      if (!hasDatabase) { report.missing += 1; return }
      await fsp.mkdir(cacheDir, { recursive: true })
    }
    const keys = new Set<string>()
    if (hasDatabase) {
      const receipt = await executeSharedFile({ operation: 'previewCleanupRows', path: dbPath, schemaVersion: options.previewSqliteSchemaVersion })
      if (!Array.isArray(receipt.result.value) || receipt.result.value.some(key => typeof key !== 'string')) throw new Error('预览清理快照不完整。')
      for (const key of receipt.result.value as string[]) keys.add(key)
    }
    let names: string[]
    try { names = await fsp.readdir(imageDir) }
    catch (error) { if (!missing(error)) throw error; names = [] }
    for (const name of names) {
      if (/^[a-f0-9]{40}\.png\.(?:render|hydrate|display)\.[^.]+\.png$/i.test(name)) {
        report.failures.push(`${imageDir}/${name}: 预览任务暂存文件已保留，请等待现有任务结束后重试`)
        continue
      }
      const key = name.match(/^(.*)\.png(?:$|\.)/i)?.[1]
      if (key) keys.add(key)
    }
    const snapshot = [...keys].filter(key => {
      if (/^[a-f0-9]{40}$/.test(key)) return true
      report.failures.push(`${imageDir}: 不支持的预览键已保留`)
      return false
    })
    for (let offset = 0; offset < snapshot.length; offset += 32) {
      const batch = snapshot.slice(offset, offset + 32)
      const receipt = await executeSharedFile({ operation: 'previewCleanupEntries', path: dbPath, dest: imageDir,
        rootPath: cacheDir, schemaVersion: options.previewSqliteSchemaVersion, previewKeys: batch })
      const rows = receipt.result.value as Array<{ key: string; status: string; rowsCommitted: boolean; message?: string }>
      if (!Array.isArray(rows) || rows.length !== batch.length || rows.some((row, index) => row?.key !== batch[index] || !['removed', 'failed'].includes(row.status) || typeof row.rowsCommitted !== 'boolean')) {
        throw new Error('预览清理结果不完整，未确认的条目已保留待检查。')
      }
      for (const row of rows) {
        if (row.status === 'removed') report.removed += 1
        else report.failures.push(`${imageDir}/${row.key}: ${row.rowsCommitted ? '索引删除已提交，图片清理未全部完成' : '已保留或未确认'}；${row.message || '清理失败'}`)
      }
    }
    // Database/manifest containers intentionally remain. New non-snapshot keys
    // may be published concurrently; only the captured keys are authorized.
  }

  function clearPreviewCache(): Promise<CacheStats> {
    return enqueue(async report => {
      await attempt(report, options.localPreviewImageDir(), () => clearPreviewGroup(report, options.localPreviewImageDir(), options.localPreviewImageDir(), options.previewSqlitePath()))
      for (const folder of await watchedFolders(report)) {
        await attempt(report, options.rootPreviewCacheDir(folder), () => clearPreviewGroup(report, options.rootPreviewCacheDir(folder), options.rootPreviewImageDir(folder), options.rootPreviewDbPath(folder)))
        await attempt(report, options.fallbackPreviewCacheDir(folder), () => clearPreviewGroup(report, options.fallbackPreviewCacheDir(folder), options.fallbackPreviewImageDir(folder), options.fallbackPreviewDbPath(folder)))
        const legacy = options.legacyRootPreviewCacheDir(folder)
        await attempt(report, legacy, () => clearPreviewGroup(report, legacy, legacy, join(legacy, 'preview.sqlite')))
      }
    })
  }
  return { clearScanCache, clearPreviewCache }
}
