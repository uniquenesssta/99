import { hasUnsettledFavoriteIntent, isSameFavoriteIntent, markFavoriteIntent, rollbackFavoriteIntent } from '../../../fontUserIntentRuntime'
import type { FontItem } from '@shared/types'
import type { FontSystemActionRuntimeOptions,FontSystemStateRuntime } from './fontSystemActionTypes'

export function createFontFavoriteActionRuntime(
  options: FontSystemActionRuntimeOptions,
  stateRuntime: Pick<FontSystemStateRuntime, 'updateFont' | 'adjustDatabaseFavoriteCount'>
): {
  toggleFontFavorite: (font: FontItem, favorite?: boolean) => Promise<void>
  setFontsFavorite: (fonts: FontItem[], favorite: boolean) => Promise<void>
} {
  async function setFontsFavorite(fonts: FontItem[], favorite: boolean): Promise<void> {
    const current = options.getCurrentLibrary()
    const unique = [...new Map(fonts.map(font => [font.id, current.fonts[font.id] || font])).values()]
    const changed = unique.filter(font => !!font.favorite !== favorite).map(font => markFavoriteIntent(font, favorite))
    const skipped = unique.length - changed.length
    if (!changed.length) { options.setStatus(`收藏状态未变化：跳过 ${skipped} 个。`); return }
    options.setLibrary(prev => ({ ...prev, fonts: { ...prev.fonts, ...Object.fromEntries(changed.map(font => [font.id, font])) } }))
    stateRuntime.adjustDatabaseFavoriteCount((favorite ? 1 : -1) * changed.length)
    options.setStatus(`正在${favorite ? '收藏' : '取消收藏'} ${changed.length} 个，跳过未变化 ${skipped} 个（仅本机）……`)
    await options.queueFavoriteWrites(changed, favorite)
    let succeeded = 0, failed = 0, superseded = 0, delta = 0
    const live = options.getCurrentLibrary()
    const updates: Record<string, FontItem> = {}
    for (const request of changed) {
      const font = live.fonts[request.id]
      if (!font || !isSameFavoriteIntent(font, request)) { superseded++; continue }
      if (hasUnsettledFavoriteIntent(request)) {
        const restored = rollbackFavoriteIntent(font, request)
        delta += Number(!!restored.favorite) - Number(!!font.favorite)
        updates[font.id] = restored
        failed++
      } else { updates[font.id] = { ...font }; succeeded++ }
    }
    if (Object.keys(updates).length) options.setLibrary(prev => {
      const fonts = { ...prev.fonts }
      for (const request of changed) if (updates[request.id] && isSameFavoriteIntent(fonts[request.id], request)) fonts[request.id] = updates[request.id]
      return { ...prev, fonts }
    })
    if (delta) stateRuntime.adjustDatabaseFavoriteCount(delta)
    // Queue success already schedules one refresh per transaction. Rollback needs
    // one revalidation too, including the all-failed case.
    if (failed) options.scheduleDatabaseDerivedStateRefresh(0)
    if (succeeded || failed) options.setStatus(`${favorite ? '收藏' : '取消收藏'}完成：成功 ${succeeded} 个，失败并回退 ${failed} 个，跳过未变化 ${skipped} 个，已被较新操作替代 ${superseded} 个（仅本机）。`)
  }

  async function toggleFontFavorite(font: FontItem, favorite?: boolean): Promise<void> {
    const live = options.getCurrentLibrary().fonts[font.id] || font
    await setFontsFavorite([live], favorite ?? !live.favorite)
  }

  return { toggleFontFavorite, setFontsFavorite }
}
