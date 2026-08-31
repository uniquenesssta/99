import type { FontItem } from '@shared/types'
import { applyFontActiveRuntimePatch,applyFontActiveRuntimeUpdatesToLibrary } from '../../../fontInstallStateRuntime'
import { fontsForTagFromLibrary } from '../../../fontSelectionRuntime'
import type { FontSystemActionRuntimeOptions,FontSystemStateRuntime } from './fontSystemActionTypes'

export function createFontSystemStateRuntime(options: FontSystemActionRuntimeOptions): FontSystemStateRuntime {
  function updateFont(fontId: string, updater: (font: FontItem) => FontItem): void {
    options.setLibrary((prev) => {
      const current = prev.fonts[fontId]
      if (!current) return prev
      return {
        ...prev,
        fonts: {
          ...prev.fonts,
          [fontId]: updater(current)
        }
      }
    })
  }

  function adjustDatabaseActiveCount(delta: number): void {
    if (!delta) return
    options.setDatabaseFontMetrics((prev) => prev ? { ...prev, activeCount: Math.max(0, prev.activeCount + delta) } : prev)
  }

  function adjustDatabaseFavoriteCount(delta: number): void {
    if (!delta) return
    options.setDatabaseFontMetrics((prev) => prev ? { ...prev, favoriteCount: Math.max(0, prev.favoriteCount + delta) } : prev)
  }

  function setFontActiveRuntime(fontId: string, active: boolean, patch: Partial<FontItem> = {}): void {
    updateFont(fontId, (current) => applyFontActiveRuntimePatch(current, active, patch))
  }

  function setFontsActiveRuntimeBulk(updates: Record<string, { active: boolean; patch?: Partial<FontItem> }>): void {
    options.setLibrary((prev) => applyFontActiveRuntimeUpdatesToLibrary(prev, updates))
  }

  function fontsForTag(tagName: string, scope: 'local' | 'shared' = 'local'): FontItem[] {
    return fontsForTagFromLibrary(options.library.fonts || {}, tagName, scope)
  }

  return {
    updateFont,
    adjustDatabaseActiveCount,
    adjustDatabaseFavoriteCount,
    setFontActiveRuntime,
    setFontsActiveRuntimeBulk,
    fontsForTag
  }
}
