import type { FontItem, FontQueryRequest, LibraryState } from '@shared/types'
import { fontsForTagFromLibrary } from './fontSelectionRuntime'

type FontCommandLibrary = Pick<LibraryState, 'fonts'> & { __partialFonts?: boolean }

export function isPartialFontLibrary(library: Pick<LibraryState, 'fonts'>): boolean {
  return (library as FontCommandLibrary).__partialFonts === true
}

export function resolveFontCommandTargets(ids: string[], library: FontCommandLibrary, available: FontItem[] = []) {
  const selectedIds = Array.from(new Set(ids.filter(Boolean)))
  const fallback = library.__partialFonts ? new Map(available.map(font => [font.id, font])) : new Map<string, FontItem>()
  const fonts: FontItem[] = [], missingIds: string[] = []
  for (const id of selectedIds) {
    const font = library.fonts[id] || fallback.get(id)
    if (font) fonts.push({ ...font })
    else missingIds.push(id)
  }
  return { selectedIds, fonts, missingIds }
}

export function missingFontCommandTargetsMessage(missingIds: string[]): string {
  return `有 ${missingIds.length} 个所选字体暂时无法读取，本次操作未执行。请重新加载该范围后重试。缺失编号：${missingIds.slice(0, 8).join('、')}${missingIds.length > 8 ? '…' : ''}`
}

// Query only on an explicit tag command. A partial renderer cache is never the full tag scope.
export async function readTagCommandTargets(
  hfm: Pick<Window['hfm'], 'queryFontPage'>,
  library: LibraryState,
  name: string,
  scope: 'local' | 'shared'
): Promise<FontItem[]> {
  if (typeof hfm.queryFontPage !== 'function') {
    if (isPartialFontLibrary(library)) throw new Error('无法读取完整标签范围，请重新加载后重试。')
    return fontsForTagFromLibrary(library.fonts, name, scope).map(font => ({ ...font }))
  }
  const request: FontQueryRequest = { sidebarPage: scope === 'shared' ? 'sharedTags' : 'tags', selectedTagName: name, activeFilter: { kind: 'all' }, installStatus: 'all', sortMode: 'nameAsc', limit: 500 }
  const fonts = new Map<string, FontItem>()
  let offset = 0, expectedTotal: number | undefined, revision: string | undefined
  do {
    const page = await hfm.queryFontPage({ ...request, offset })
    const shared = page.tagRevision?.sharedMetadataSignatures || {}
    const nextRevision = JSON.stringify([page.tagRevision?.localTagsSignature, Object.keys(shared).sort().map(key => [key, shared[key]])])
    if (page.engine === 'none' || !Number.isSafeInteger(page.total) || page.total < 0 || page.offset !== offset ||
      (expectedTotal !== undefined && (expectedTotal !== page.total || revision !== nextRevision))) throw new Error('标签范围读取不完整或读取期间已变化，请重试。')
    if (page.total > 100000) throw new Error('标签超过 100000 个字体，请分组后操作。')
    expectedTotal = page.total
    revision = nextRevision
    for (const font of page.items) {
      if (!font.id || fonts.has(font.id)) throw new Error('标签分页结果重复或不完整，请重试。')
      fonts.set(font.id, { ...font })
    }
    offset += page.items.length
    if (offset > expectedTotal || (!page.items.length && offset < expectedTotal) || (offset === expectedTotal && page.truncated === true)) throw new Error('标签范围读取不完整，请重试。')
  } while (offset < expectedTotal)
  return Array.from(fonts.values())
}
