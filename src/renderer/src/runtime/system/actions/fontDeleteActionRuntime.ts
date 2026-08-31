import type { FontItem } from '@shared/types'
import { removeFontsFromLibrary,uniqueFontsById } from '../../../fontFolderMutationRuntime'
import { physicalMutationIndexRefreshSuffix,refreshIndexesAfterPhysicalMutation } from '../../library/fontPhysicalMutationIndexRuntime'
import type { FontSystemActionRuntimeOptions } from './fontSystemActionTypes'

export function createFontDeleteActionRuntime(options: FontSystemActionRuntimeOptions): {
  deleteFontsBatch: (fonts: FontItem[], label: string) => Promise<void>
} {
  async function deleteFontsBatch(fonts: FontItem[], label: string): Promise<void> {
    options.setContextMenu(null)
    const unique = uniqueFontsById(fonts)
    if (!unique.length) return

    const ok = window.confirm(`将把“${label}”中的 ${unique.length} 个字体文件删除到回收站。已安装、已激活、受保护或不在监听文件夹内的字体会自动跳过。确定继续？`)
    if (!ok) return

    const currentLibrary = options.getCurrentLibrary()
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

    options.setStatus(`${result.message}${refreshSuffix}`)
  }

  return { deleteFontsBatch }
}
