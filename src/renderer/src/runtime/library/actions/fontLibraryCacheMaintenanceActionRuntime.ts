import type { FontLibraryIndexActionRuntimeOptions } from './fontLibraryIndexActionTypes'

export function createFontLibraryCacheMaintenanceActionRuntime(options: FontLibraryIndexActionRuntimeOptions): {
  clearAllCacheAction: () => Promise<void>
  clearPreviewCacheAction: () => Promise<void>
} {
  async function clearAllCacheAction(): Promise<void> {
    if (!window.confirm('清理索引缓存和预览缓存？字体库记录、标签、共享标签和文件本身不会删除。')) return

    try {
      options.setStatus('正在清理缓存：索引缓存和预览缓存都会删除，字体库记录保留……')
      await options.hfm.clearScanCache()
      const stats = await options.hfm.clearPreviewCache()
      options.setCacheStats(stats)
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
      options.setStatus('已清理缓存：索引缓存和预览缓存已删除；字体库记录保留。需要重新生成时请点击“重建索引”或“更新索引”。')
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
      const stats = await options.hfm.clearPreviewCache()
      options.setCacheStats(stats)
      options.setStatus(`已清理预览缓存、${previewCount} 个预览失败标记，并清理 ${invalidCount} 条无效记录。字体索引未删除；新预览会在字体卡进入可见区域时按需生成。`)
    } catch (error) {
      options.setStatus(`清理预览缓存失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return {
    clearAllCacheAction,
    clearPreviewCacheAction
  }
}
