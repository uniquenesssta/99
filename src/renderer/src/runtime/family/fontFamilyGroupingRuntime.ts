import type { FontItem,FontQueryRequest } from '@shared/types'
import { fontDisplayName,fontFileDisplayName } from '../../appRuntime'

export type FontFamilyGroup = {
  id: string
  key: string
  name: string
  primaryFont: FontItem
  fonts: FontItem[]
  styles: string[]
}

export type FontFamilyGroupResult = {
  groups: FontFamilyGroup[]
  totalFonts: number
  totalGroups: number
  hiddenSingleFontCount: number
  hiddenDuplicateStyleCount: number
  truncated: boolean
  elapsedMs: number
}

const FAMILY_PAGE_LIMIT = 180
const FAMILY_MAX_FONTS = 3600

const STYLE_SUFFIX_WORDS = [
  'thin',
  'extralight',
  'ultralight',
  'light',
  'regular',
  'normal',
  'book',
  'roman',
  'medium',
  'semibold',
  'demibold',
  'bold',
  'extrabold',
  'ultrabold',
  'black',
  'heavy',
  'italic',
  'oblique',
  'condensed',
  'narrow',
  'expanded',
  '常规',
  '标准',
  '粗体',
  '细体',
  '中黑',
  '中等',
  '斜体'
]

const REGULAR_STYLE_WORDS = [
  'regular',
  'normal',
  'book',
  'roman',
  'plain',
  '常规',
  '标准'
]

function stripFileExtension(value: string): string {
  return value.replace(/\.(ttf|ttc|otf|otc|woff2?|fon)$/i, '')
}

function collapseSpaces(value: string): string {
  return value.replace(/[\s_-]+/g, ' ').trim()
}

function stripStyleSuffix(value: string): string {
  let next = collapseSpaces(stripFileExtension(value))
  for (let i = 0; i < 3; i += 1) {
    const before = next
    for (const word of STYLE_SUFFIX_WORDS) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      next = next.replace(new RegExp(`(?:[\\s_-]+|(?=[A-Z]))${escaped}$`, 'i'), '').trim()
    }
    if (next === before) break
  }
  return next || value.trim()
}

function normalizeFamilyKey(value: string): string {
  return collapseSpaces(value)
    .toLocaleLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
}

function familyNameForFont(font: FontItem): string {
  const family = stripStyleSuffix(font.family || '')
  if (family) return family
  const fullName = stripStyleSuffix(font.fullName || '')
  if (fullName) return fullName
  const postscript = stripStyleSuffix((font.postscriptName || '').replace(/[A-Z](?=[a-z])/g, ' $&'))
  if (postscript) return postscript
  return stripStyleSuffix(font.fileName || fontDisplayName(font) || font.id)
}

function styleLabelForFont(font: FontItem): string {
  const style = collapseSpaces(font.style || '')
  if (style) return style
  const fullName = collapseSpaces(stripFileExtension(font.fullName || font.fileName || ''))
  const family = collapseSpaces(familyNameForFont(font))
  const suffix = fullName.toLocaleLowerCase().startsWith(family.toLocaleLowerCase())
    ? fullName.slice(family.length).replace(/^[\s_-]+/, '')
    : ''
  return suffix || 'Regular'
}

function primaryScore(font: FontItem): number {
  const style = styleLabelForFont(font).toLocaleLowerCase()
  if (REGULAR_STYLE_WORDS.some((word) => style === word || style.includes(word))) return 0
  if (style.includes('medium')) return 1
  if (style.includes('light')) return 2
  if (style.includes('bold')) return 3
  if (style.includes('italic') || style.includes('oblique')) return 4
  return 5
}


function normalizeStyleKey(value: string): string {
  return collapseSpaces(value)
    .toLocaleLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, '')
}

function isRealFamilyBucket(fonts: FontItem[]): boolean {
  if (fonts.length < 2) return false
  const styleKeys = new Set(fonts.map((font) => font.styleKey || normalizeStyleKey(styleLabelForFont(font))).filter(Boolean))
  if (styleKeys.size > 1) return true
  const fileKeys = new Set(fonts.map((font) => stripFileExtension(font.fileName || '').toLocaleLowerCase()).filter(Boolean))
  return fileKeys.size > 1 && styleKeys.size > 1
}

function compareFamilyFonts(a: FontItem, b: FontItem): number {
  return primaryScore(a) - primaryScore(b)
    || styleLabelForFont(a).localeCompare(styleLabelForFont(b), 'zh-Hans-CN')
    || fontDisplayName(a).localeCompare(fontDisplayName(b), 'zh-Hans-CN')
    || fontFileDisplayName(a).localeCompare(fontFileDisplayName(b), 'zh-Hans-CN')
}

export function buildFontFamilyGroups(fonts: FontItem[]): { groups: FontFamilyGroup[]; hiddenSingleFontCount: number; hiddenDuplicateStyleCount: number } {
  const buckets = new Map<string, { name: string; fonts: FontItem[] }>()
  for (const font of fonts) {
    if (!font?.id) continue
    const name = familyNameForFont(font)
    const key = font.familyKey || normalizeFamilyKey(name || fontDisplayName(font))
    const bucket = buckets.get(key)
    if (bucket) bucket.fonts.push(font)
    else buckets.set(key, { name: name || fontDisplayName(font), fonts: [font] })
  }

  let hiddenSingleFontCount = 0
  let hiddenDuplicateStyleCount = 0
  const groups = Array.from(buckets.entries())
    .flatMap(([key, bucket]) => {
      const sortedFonts = [...bucket.fonts].sort(compareFamilyFonts)
      const styles = Array.from(new Set(sortedFonts.map(styleLabelForFont).filter(Boolean)))
      if (sortedFonts.length < 2) {
        hiddenSingleFontCount += sortedFonts.length
        return []
      }
      if (!isRealFamilyBucket(sortedFonts)) {
        hiddenDuplicateStyleCount += sortedFonts.length
        return []
      }
      return [{
        id: key,
        key,
        name: bucket.name,
        primaryFont: sortedFonts[0],
        fonts: sortedFonts,
        styles
      }]
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || b.fonts.length - a.fonts.length)

  return { groups, hiddenSingleFontCount, hiddenDuplicateStyleCount }
}


export function fontFamilyQueryScopeKey(request: FontQueryRequest): string {
  const scoped = { ...(request || {}) }
  delete scoped.limit
  delete scoped.offset
  return JSON.stringify(scoped)
}

export async function loadFontFamilyGroups(
  hfm: typeof window.hfm,
  baseRequest: FontQueryRequest,
  isStale: () => boolean
): Promise<FontFamilyGroupResult> {
  const startedAt = performance.now()
  const fonts: FontItem[] = []
  let offset = 0
  let total = 0
  let truncated = false

  while (!isStale() && fonts.length < FAMILY_MAX_FONTS) {
    const page = await hfm.queryFontPage({
      ...baseRequest,
      sortMode: 'nameAsc',
      limit: FAMILY_PAGE_LIMIT,
      offset
    })
    if (isStale()) break
    total = page.total
    fonts.push(...page.items)
    offset += page.items.length
    if (!page.items.length || offset >= page.total || !page.truncated) break
    if (fonts.length >= FAMILY_MAX_FONTS) truncated = true
  }

  const result = buildFontFamilyGroups(fonts)
  return {
    groups: result.groups,
    totalFonts: total || fonts.length,
    totalGroups: result.groups.length,
    hiddenSingleFontCount: result.hiddenSingleFontCount,
    hiddenDuplicateStyleCount: result.hiddenDuplicateStyleCount,
    truncated,
    elapsedMs: Math.round(performance.now() - startedAt)
  }
}
