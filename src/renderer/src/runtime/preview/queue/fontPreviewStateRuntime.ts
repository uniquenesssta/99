import type { FontItem } from '@shared/types'
import { canQueuePreviewFont } from '../../../fontPreviewStateRuntime'
import type { FontPreviewQueueRuntimeOptions,FontPreviewStateRuntime } from './fontPreviewQueueTypes'

export function createFontPreviewStateRuntime(options: FontPreviewQueueRuntimeOptions): FontPreviewStateRuntime {
  function resetPreviewRuntimeState(): void {
    options.previewQueue.current = []
    options.queuedPreviewFontIds.current.clear()
    options.loadingFonts.current.clear()
    options.activePreviewLoads.current = 0
    options.autoPreviewCacheQueue.current = []
    options.queuedAutoPreviewCacheIds.current.clear()
    options.activeAutoPreviewCacheLoads.current = 0
    options.autoPreviewCacheStats.current = { total: 0, done: 0, cached: 0, generated: 0, failed: 0 }
    options.setFailedPreviewFontIds({})
    options.setNativePreviewImages({})
    options.setNativeDetailImage('')
  }

  function canRequestPreviewFont(font: FontItem): boolean {
    return canQueuePreviewFont({
      font,
      previewFamilies: options.previewFamilies,
      nativePreviewImages: options.nativePreviewImages,
      failedPreviewFontIds: options.failedPreviewFontIds,
      loadingFontIds: options.loadingFonts.current,
      queuedPreviewFontIds: options.queuedPreviewFontIds.current,
      isBadFontRecord: options.isBadFontRecord
    })
  }

  return {
    resetPreviewRuntimeState,
    canRequestPreviewFont
  }
}
