import type { FontItem,PhysicalFolderTreeResult } from '@shared/types'
import { applyFolderTreeToLibrary,mergeScannedFonts,scanWorkerStatsText } from '../../../appRuntime'
import { ensureLibraryTagNamesContainFontTags } from '../../../fontTagStateAuthorityRuntime'
import type { FontLibraryIndexActionRuntimeOptions,FontLibraryIndexSharedRuntime } from './fontLibraryIndexActionTypes'

export function createFontLibrarySystemScanActionRuntime(
  options: FontLibraryIndexActionRuntimeOptions,
  sharedRuntime: Pick<FontLibraryIndexSharedRuntime, 'finishIndexingWithoutFullInstallRefresh' | 'invalidateDatabasePages' | 'isCancelledScanResult' | 'loadCacheStats' | 'readPhysicalFolderTree'>
): {
  scanInstalledFontsIntoLibrary: () => Promise<void>
  scanAllFonts: () => Promise<void>
} {
  let scanAllFontsTask: Promise<void> | null = null

  async function scanInstalledFontsIntoLibrary(): Promise<void> {
    options.setStatus('正在扫描 Windows 已安装字体……')

    try {
      const result = await options.hfm.scanSystemInstalledFonts()

      const nextLibraryForRefresh = options.commitLibraryUpdate((prev) => ensureLibraryTagNamesContainFontTags({
        ...prev,
        fonts: mergeScannedFonts(prev.fonts, result.fonts)
      }))

      const statusText = result.stats ? `系统字体扫描完成：导入/更新 ${result.fonts.length} 个，跳过 ${result.stats.skippedBad} 个，用时 ${Math.round(result.stats.durationMs / 1000)} 秒${scanWorkerStatsText(result.stats)}。` : `系统字体扫描完成：${result.fonts.length} 个。`
      if (!await options.saveLibraryImmediately(nextLibraryForRefresh)) {
        options.setStatus('系统字体扫描完成，但库状态保存失败；本次未刷新数据库派生状态。')
        return
      }
      await options.startBackgroundInstallStatusRefresh(statusText)
      sharedRuntime.invalidateDatabasePages()
    } catch (error) {
      options.setStatus(`扫描系统字体失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  function scanAllFonts(): Promise<void> {
    if (scanAllFontsTask) return scanAllFontsTask
    let task: Promise<void>
    task = (async () => {
      options.setStatus('正在扫描字体文件夹和 Windows 系统字体……')

      try {
        const currentLibrary = options.getCurrentLibrary()
        let workingFolders = currentLibrary.folders
        let folderFonts: FontItem[] = []
        let folderStatsText = '未扫描字体文件夹'

        if (!workingFolders.length) {
          const picked = await options.hfm.selectFontFolders()
          if (picked.length) {
            workingFolders = Array.from(new Set(picked))
          }
        }

        let tree: PhysicalFolderTreeResult = { folders: workingFolders, nodes: currentLibrary.folderNodes || [] }

        if (workingFolders.length) {
          tree = await sharedRuntime.readPhysicalFolderTree(workingFolders)
          workingFolders = tree.folders
          const folderResult = await options.hfm.scanFolders(workingFolders, Object.values(currentLibrary.fonts || {}))
          if (sharedRuntime.isCancelledScanResult(folderResult)) return
          folderFonts = []
          const indexedCount = folderResult.stats?.totalFiles ?? 0
          folderStatsText = folderResult.stats
            ? `文件夹索引 ${indexedCount} 个，复用 ${folderResult.stats.fromCache} 个，新解析 ${folderResult.stats.parsed} 个，跳过 ${folderResult.stats.skippedBad} 个${scanWorkerStatsText(folderResult.stats)}`
            : `文件夹索引 ${indexedCount} 个`
        }

        const systemResult = await options.hfm.scanSystemInstalledFonts()

        const nextLibraryForRefresh = options.commitLibraryUpdate((prev) => {
          const synced = applyFolderTreeToLibrary(prev, tree, folderFonts.length ? folderFonts : undefined)
          return ensureLibraryTagNamesContainFontTags({
            ...synced,
            fonts: mergeScannedFonts(synced.fonts, systemResult.fonts)
          })
        })

        if (!await options.saveLibraryImmediately(nextLibraryForRefresh)) {
          options.setStatus('扫描完成，但库状态保存失败；本次未刷新文件夹统计。')
          return
        }
        await sharedRuntime.loadCacheStats()
        await sharedRuntime.finishIndexingWithoutFullInstallRefresh(`扫描完成：${folderStatsText}；系统字体 ${systemResult.fonts.length} 个。`)

        options.setStatus(
          `扫描完成：${folderStatsText}；系统字体 ${systemResult.fonts.length} 个。已跳过自动全量刷新已安装状态，避免界面卡顿。`
        )
      } catch (error) {
        options.setStatus(`扫描失败：${error instanceof Error ? error.message : String(error)}`)
      }
    })().finally(() => {
      if (scanAllFontsTask === task) scanAllFontsTask = null
    })
    scanAllFontsTask = task
    return task
  }


  return {
    scanInstalledFontsIntoLibrary,
    scanAllFonts
  }
}
