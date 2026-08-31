import { applyFolderTreeToLibrary,scanWorkerStatsText } from '../../../appRuntime'
import type { FontLibraryIndexActionRuntimeOptions,FontLibraryIndexSharedRuntime } from './fontLibraryIndexActionTypes'

export function createFontLibraryIndexOperationActionRuntime(
  options: FontLibraryIndexActionRuntimeOptions,
  sharedRuntime: Pick<FontLibraryIndexSharedRuntime, 'finishIndexingWithoutFullInstallRefresh' | 'isCancelledScanResult' | 'loadCacheStats' | 'readPhysicalFolderTree'>
): {
  cancelIndexing: () => Promise<void>
  rescan: () => Promise<void>
  rebuildScanCache: () => Promise<void>
} {
  async function cancelIndexing(): Promise<void> {
    if (typeof options.hfm.cancelFontScan !== 'function') {
      options.setStatus('当前 preload 缺少取消索引接口。')
      return
    }

    try {
      const result = await options.hfm.cancelFontScan('用户取消了索引扫描。')
      if (result.cancelled) {
        options.setStatus('正在取消索引扫描，后台 Worker 会尽快停止……')
      } else {
        options.setIndexingActive(false)
        options.setStatus(result.message || '当前没有正在运行的索引扫描。')
      }
    } catch (error) {
      options.setStatus(`取消索引失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function rescan(): Promise<void> {
    const currentLibrary = options.getCurrentLibrary()
    if (!currentLibrary.folders.length) {
      options.setStatus('请先添加字体文件夹')
      return
    }

    const runId = options.nextIndexOperationRunId()
    options.setStatus('正在更新索引：对比字体文件状态，只解析新增或修改的文件……')
    const tree = await sharedRuntime.readPhysicalFolderTree(currentLibrary.folders)
    if (!options.isCurrentIndexOperation(runId)) return
    const scrollSnapshot = options.captureFontScrollSnapshot()
    const result = await options.hfm.scanFolders(tree.folders, Object.values(currentLibrary.fonts || {}))
    if (sharedRuntime.isCancelledScanResult(result)) return
    if (!options.isCurrentIndexOperation(runId)) return
    const nextLibrary = options.commitLibraryUpdate((prev) => applyFolderTreeToLibrary(prev, tree))
    options.restoreFontScrollSnapshot(scrollSnapshot)
    if (!await options.saveLibraryImmediately(nextLibrary)) {
      options.setStatus('更新索引完成，但文件夹树保存失败；为避免显示错误数量，本次未刷新文件夹统计。')
      return
    }

    await sharedRuntime.loadCacheStats()
    const indexedCount = result.stats?.totalFiles ?? 0
    const statusText = result.stats ? `更新索引完成：索引 ${indexedCount} 个字体文件，复用索引 ${result.stats.fromCache} 个，新解析 ${result.stats.parsed} 个，跳过 ${result.stats.skippedBad} 个，用时 ${Math.round(result.stats.durationMs / 1000)} 秒${scanWorkerStatsText(result.stats)}。` : `更新索引完成：索引 ${indexedCount} 个字体文件，跳过/错误 ${result.errors.length} 个`
    await sharedRuntime.finishIndexingWithoutFullInstallRefresh(statusText)
  }

  async function rebuildScanCache(): Promise<void> {
    const currentLibrary = options.getCurrentLibrary()
    if (!currentLibrary.folders.length) {
      options.setStatus('请先添加字体文件夹')
      return
    }

    options.setStatus('正在完全重建索引：先清理旧索引，再重新解析字体文件夹……')
    try {
      const runId = options.nextIndexOperationRunId()
      await options.hfm.clearScanCache()
      if (!options.isCurrentIndexOperation(runId)) return
      const tree = await sharedRuntime.readPhysicalFolderTree(currentLibrary.folders)
      if (!options.isCurrentIndexOperation(runId)) return
      const scrollSnapshot = options.captureFontScrollSnapshot()
      const result = await options.hfm.scanFolders(tree.folders, [])
      if (sharedRuntime.isCancelledScanResult(result)) return
      if (!options.isCurrentIndexOperation(runId)) return
      const nextLibrary = options.commitLibraryUpdate((prev) => applyFolderTreeToLibrary(prev, tree))
      options.restoreFontScrollSnapshot(scrollSnapshot)
      if (!await options.saveLibraryImmediately(nextLibrary)) {
        options.setStatus('完全重建索引完成，但文件夹树保存失败；为避免显示错误数量，本次未刷新文件夹统计。')
        return
      }

      await sharedRuntime.loadCacheStats()
      const indexedCount = result.stats?.totalFiles ?? 0
      const statusText = result.stats ? `完全重建索引完成：索引 ${indexedCount} 个字体文件，新解析 ${result.stats.parsed} 个，跳过 ${result.stats.skippedBad} 个，用时 ${Math.round(result.stats.durationMs / 1000)} 秒${scanWorkerStatsText(result.stats)}。` : `完全重建索引完成：索引 ${indexedCount} 个字体文件，跳过/错误 ${result.errors.length} 个`
      await sharedRuntime.finishIndexingWithoutFullInstallRefresh(statusText)
    } catch (error) {
      options.setStatus(`完全重建索引失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    cancelIndexing,
    rescan,
    rebuildScanCache
  }
}
