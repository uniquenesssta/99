import type { FontItem } from '../../../shared/types'

export type MergedIndexCategory =
  | 'serif'
  | 'slabSerif'
  | 'sansSerif'
  | 'script'
  | 'monospace'
  | 'handwriting'
  | 'hei'
  | 'art'

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function categoryTextFromFont(font: Partial<FontItem> | Record<string, unknown>): string {
  const tagNames = Array.isArray((font as any).tagNames) ? (font as any).tagNames : []
  return [
    (font as any).fileName,
    (font as any).path,
    (font as any).family,
    (font as any).fullName,
    (font as any).postscriptName,
    (font as any).style,
    ...tagNames,
  ].map(normalizeText).filter(Boolean).join(' ').toLowerCase()
}

export function inferMergedIndexCategory(font: Partial<FontItem> | Record<string, unknown>): MergedIndexCategory {
  const text = categoryTextFromFont(font)
  const rules: Array<[MergedIndexCategory, RegExp]> = [
    ['monospace', /(mono|monospace|code|console|consola|courier|等宽|等寬)/i],
    ['handwriting', /(handwriting|handwritten|marker|brush|calligraphy|手写|手寫|马克笔|麥克筆)/i],
    ['script', /(script|cursive|sign|signature|swash|草书|草書|行书|行書|连笔|連筆)/i],
    ['slabSerif', /(slab|egyptian|rockwell|clarendon|粗衬线|粗襯線)/i],
    ['hei', /(黑体|黑體|雅黑|heiti|hei|gothic|sans cjk|source han sans|noto sans cjk|思源黑|苹方|蘋方)/i],
    ['serif', /(serif|song|sung|mincho|ming|宋体|宋體|明体|明體|明朝|思源宋|source han serif|noto serif cjk|times|georgia)/i],
    ['art', /(display|decorative|poster|headline|banner|art|pop|title|装饰|裝飾|海报|海報|标题|標題|综艺|綜藝)/i],
    ['sansSerif', /(sans|gothic|ui|arial|helvetica|calibri|verdana|tahoma|无衬线|無襯線)/i],
  ]
  for (const [category, pattern] of rules) {
    if (pattern.test(text)) return category
  }
  return 'sansSerif'
}

export function inferMergedIndexCategoryFromJson(fontJson?: string | null): MergedIndexCategory {
  if (!fontJson) return 'sansSerif'
  try {
    const parsed = JSON.parse(fontJson)
    if (!parsed || typeof parsed !== 'object') return 'sansSerif'
    return inferMergedIndexCategory(parsed as Record<string, unknown>)
  } catch {
    return 'sansSerif'
  }
}
