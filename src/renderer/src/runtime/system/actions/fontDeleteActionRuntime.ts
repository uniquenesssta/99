import type { FontItem } from '@shared/types'
import { removeFontsFromLibrary,uniqueFontsById } from '../../../fontFolderMutationRuntime'
import { physicalMutationIndexRefreshSuffix,refreshIndexesAfterPhysicalMutation } from '../../library/fontPhysicalMutationIndexRuntime'
import type { FontSystemActionRuntimeOptions } from './fontSystemActionTypes'

export function createFontDeleteActionRuntime(options: FontSystemActionRuntimeOptions): {
  deleteFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
} {
  async function deleteFontsBatch(fonts: FontItem[], label: string): Promise<void> {
    options.setContextMenu(null)
    const busy = options.activeOperationFontIds?.current
    const selected = uniqueFontsById(fonts)
    const unique = selected.filter(font => !busy?.has(font.id))
    const skippedBusy = selected.length - unique.length
    if (!unique.length) { options.setStatus(`没有可删除字体：删除 0 个，跳过处理中 ${skippedBusy} 个。`); return }

    const ok = window.confirm(`将把“${label}”中的 ${unique.length} 个字体文件删除到回收站（所选 ${selected.length} 个，跳过处理中 ${skippedBusy} 个）。已安装、已激活、受保护或不在监听文件夹内的字体会自动跳过。确定继续？`)
    if (!ok) { options.setStatus(`已取消删除，未执行 ${unique.length} 个。`); return }

    for (const font of unique) busy?.add(font.id)
    try {
      const currentLibrary = options.getCurrentLibrary()
      options.setStatus(`正在删除字体文件：${unique.length} 个，安全检查后移入回收站……`)
      const result = await options.hfm.deleteFontFiles(unique, currentLibrary.folders || [])
      let refreshSuffix = ''
      if (result.deletedIds.length) {
        const deletedIds = new Set(result.deletedIds)
        const deletedPaths = unique.filter((font) => deletedIds.has(font.id)).map((font) => font.path)
        options.setLibrary((prev) => removeFontsFromLibrary(prev, result.deletedIds))
        options.setSelectedFontIds((prev) => prev.filter((id) => !deletedIds.has(id)))
        if (deletedIds.has(options.getCurrentSelectedFontId())) {
          options.setSelectedFontId('')
          options.setDetailVisible(false)
        }
        const refreshReport = await refreshIndexesAfterPhysicalMutation({
          hfm: options.hfm,
          watchedFolders: currentLibrary.folders || [],
          affectedPaths: deletedPaths
        })
        refreshSuffix = physicalMutationIndexRefreshSuffix(refreshReport)
      }

      options.setStatus(`${result.message} 删除 ${result.deletedIds.length} 个，跳过 ${(result.skippedProtected || 0) + (result.skippedInstalled || 0) + (result.skippedUnsafe || 0)} 个，失败 ${result.failed?.length || 0} 个；跳过处理中 ${skippedBusy} 个。${refreshSuffix}`)
    } finally {
      for (const font of unique) busy?.delete(font.id)
    }
  }

  return { deleteFontsBatch }
}
