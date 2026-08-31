import type { FontItem } from '@shared/types'
import { FONT_OBJECT_LRU_LIMIT } from '../appConstants'
import { normalizeFontPathForCompare } from './libraryNormalizeBase'

// Shared indexes can contain tens of thousands of fonts. The renderer only
// needs a small hydrated working window; database paging remains the source of
// truth for the full library.
export const FOLDER_CACHE_RENDERER_FONT_WINDOW_LIMIT = Math.min(FONT_OBJECT_LRU_LIMIT, 720)

function isPinnedRendererFont(font: FontItem | undefined): boolean {
  return !!(
    font &&
    (font.active || font.favorite || font.deleteProtected || font.localTagNames?.length || font.tagNames?.length)
  )
}

export function selectRendererFontHydrationWindow(
  cachedFonts: FontItem[],
  existingFonts: Record<string, FontItem> | undefined,
  limit = FOLDER_CACHE_RENDERER_FONT_WINDOW_LIMIT
): FontItem[] {
  if (!cachedFonts.length || cachedFonts.length <= limit) return cachedFonts

  const existing = existingFonts || {}
  const existingPathToId = new Map<string, string>()
  for (const [id, font] of Object.entries(existing)) {
    if (!font?.path) continue
    existingPathToId.set(normalizeFontPathForCompare(font.path), id)
  }

  const selected: FontItem[] = []
  const selectedIds = new Set<string>()

  const add = (font: FontItem | undefined): void => {
    if (!font?.id || selectedIds.has(font.id)) return
    selectedIds.add(font.id)
    selected.push(font)
  }

  for (const font of cachedFonts) {
    const existingId = existing[font.id] ? font.id : existingPathToId.get(normalizeFontPathForCompare(font.path))
    if (isPinnedRendererFont(existingId ? existing[existingId] : undefined) || isPinnedRendererFont(font)) add(font)
  }

  for (const font of cachedFonts) {
    if (selected.length >= limit) break
    add(font)
  }

  return selected
}
