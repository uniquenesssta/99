import { markFavoriteIntent } from '../../../fontUserIntentRuntime'
import type { FontItem } from '@shared/types'
import type { FontSystemActionRuntimeOptions,FontSystemStateRuntime } from './fontSystemActionTypes'

export function createFontFavoriteActionRuntime(
  options: FontSystemActionRuntimeOptions,
  stateRuntime: Pick<FontSystemStateRuntime, 'updateFont' | 'adjustDatabaseFavoriteCount'>
): {
  toggleFontFavorite: (font: FontItem, favorite?: boolean) => Promise<void>
} {
  async function toggleFontFavorite(font: FontItem, favorite?: boolean): Promise<void> {
    const liveFont = (options.getCurrentLibrary?.() || options.library).fonts[font.id] || font
    const nextValue = favorite ?? !liveFont.favorite
    if (nextValue === !!liveFont.favorite) { options.setStatus('收藏状态未变化：跳过 1 个。'); return }
    options.setLibrary?.(prev => prev.fonts[font.id] ? prev : { ...prev, fonts: { ...prev.fonts, [font.id]: liveFont } })
    const nextFont = markFavoriteIntent(liveFont, nextValue)

    stateRuntime.updateFont(liveFont.id, () => nextFont)
    stateRuntime.adjustDatabaseFavoriteCount(nextValue ? 1 : -1)
    options.queueFavoriteWrite(nextFont, nextValue)
    options.setStatus(`${nextValue ? '收藏' : '取消收藏'}已在界面生效，后台队列写入。`)
  }

  return { toggleFontFavorite }
}
