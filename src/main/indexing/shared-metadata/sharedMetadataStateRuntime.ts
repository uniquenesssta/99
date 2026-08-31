import type { FontItem } from '../../../shared/types'

export type SharedMetadataState = {
  tagNames: string[]
  favorite: boolean
  deleteProtected: boolean
}

export type SharedMetadataRow = {
  font_id?: string | null
  relative_path?: string | null
  path_key?: string | null
  tag_names_json?: string | null
  favorite?: number | null
  delete_protected?: number | null
  revision?: number | null
}


export function cleanTagNames(tagNamesInput: string[] | undefined): string[] {
  return Array.from(
    new Set(
      (tagNamesInput || [])
        .map((tag) => String(tag || '').trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

export function parseTagNames(value: string | null | undefined): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) return []
    return cleanTagNames(parsed.map((item) => {
      if (typeof item === 'string') return item
      if (typeof item === 'number' || typeof item === 'boolean') return String(item)
      return ''
    }))
  } catch {
    return []
  }
}

export function stateFromFont(font: FontItem): SharedMetadataState {
  return {
    tagNames: cleanTagNames(font.tagNames || []),
    favorite: !!font.favorite,
    deleteProtected: !!font.deleteProtected,
  }
}

export function stateFromRow(row: SharedMetadataRow | undefined): SharedMetadataState | null {
  if (!row) return null
  return {
    tagNames: parseTagNames(row.tag_names_json),
    favorite: !!row.favorite,
    deleteProtected: !!row.delete_protected,
  }
}

export function applyStateToFont(font: FontItem, state: SharedMetadataState | null): FontItem {
  if (!state) return font
  return {
    ...font,
    tagNames: cleanTagNames(state.tagNames),
    favorite: !!state.favorite,
    deleteProtected: !!state.deleteProtected,
  }
}

export function fontPathKey(font: FontItem | undefined, fallbackPath = ''): string {
  return String(font?.path || fallbackPath || '').replace(/\\/g, '/').toLowerCase()
}

export function uniqueFontItems(items: FontItem[]): FontItem[] {
  return Array.from(
    new Map(
      (items || []).filter((item) => !!item?.id).map((item) => [item.id, item]),
    ).values(),
  )
}
