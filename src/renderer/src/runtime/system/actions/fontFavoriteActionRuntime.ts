import type { FontItem } from '@shared/types'
import type { FontSystemActionRuntimeOptions,FontSystemStateRuntime } from './fontSystemActionTypes'

export function createFontFavoriteActionRuntime(
  options: FontSystemActionRuntimeOptions,
  stateRuntime: Pick<FontSystemStateRuntime, 'updateFont' | 'adjustDatabaseFavoriteCount'>
): {
  toggleFontFavorite: (font: FontItem) => Promise<void>
} {
  async function toggleFontFavorite(font: FontItem): Promise<void> {
    const liveFont = options.library.fonts[font.id] || font
    const nextValue = !liveFont.favorite
    const nextFont = { ...liveFont, favorite: nextValue }

    stateRuntime.updateFont(liveFont.id, () => nextFont)
    stateRuntime.adjustDatabaseFavoriteCount(nextValue ? 1 : -1)
    options.queueFavoriteWrite(nextFont, nextValue)
    options.setStatus(`${nextValue ? '收藏' : '取消收藏'}已在界面生效，后台队列写入。`)
  }

  return { toggleFontFavorite }
}
