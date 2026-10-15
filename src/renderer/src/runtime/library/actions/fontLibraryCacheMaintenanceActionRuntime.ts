import { confirmUserAction } from '../../../confirmationDialogRuntime'
import type { FontLibraryIndexActionRuntimeOptions } from './fontLibraryIndexActionTypes'

export function createFontLibraryCacheMaintenanceActionRuntime(options: FontLibraryIndexActionRuntimeOptions): {
  clearAllCacheAction: () => Promise<void>
  clearPreviewCacheAction: () => Promise<void>
} {
  async function clearAllCacheAction(): Promise<void> {
    if (!await confirmUserAction('重置扫描缓存并清理预览缓存？现有索引保留至重建完成；标签、共享标签和字体文件不会删除。')) return

    try {
      options.setStatus('正在重置扫描缓存并清理预览缓存，现有索引保留至重建完成……')
      const results = await Promise.allSettled([options.hfm.clearScanCache(), options.hfm.clearPreviewCache()])
      const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : [])
      options.resetPreviewRuntimeState()
      options.setLibrary((prev) => ({
        ...prev,
        fonts: Object.fromEntries(
          Object.entries(prev.fonts || {}).map(([id, font]) => [
            id,
            {
              ...font,
              previewDisabled: false,
              previewError: undefined
            }
          ])
        )
      }))
      if (failures.length) throw new Error(failures.join('；'))
      options.setStatus('已重置扫描缓存并清理本次预览缓存；旧索引保留至重建完成，预览数据库容器及同时新生成的预览不会强制删除。请点击“重建索引”或“更新索引”重新生成。')
    } catch (error) {
      options.setStatus(`清理缓存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function clearPreviewCacheAction(): Promise<void> {
    let previewCount = 0
    let invalidCount = 0

    options.setLibrary((prev) => {
      const validFonts = Object.fromEntries(
        Object.entries(prev.fonts)
          .filter(([, font]) => {
            const valid = !options.isBadFontRecord(font)
            if (!valid) invalidCount += 1
            return valid
          })
          .map(([id, font]) => {
            if (font.previewDisabled || font.previewError) previewCount += 1
            return [
              id,
              {
                ...font,
                previewDisabled: false,
                previewError: undefined
              }
            ]
          })
      )

      return {
        ...prev,
        fonts: validFonts
      }
    })

    options.resetPreviewRuntimeState()

    try {
      await options.hfm.clearPreviewCache()
      options.setStatus(`已清理本次预览缓存、${previewCount} 个预览失败标记，并清理 ${invalidCount} 条无效记录。字体索引未删除；新预览会在字体卡进入可见区域时按需生成。`)
    } catch (error) {
      options.setStatus(`清理预览缓存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    clearAllCacheAction,
    clearPreviewCacheAction
  }
}
