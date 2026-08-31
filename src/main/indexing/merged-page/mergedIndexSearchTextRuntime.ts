import type { FontItem } from '../../../shared/types'
import { inferMergedIndexCategory } from './mergedIndexCategoryRuntime'

const SCRIPT_LABELS: Record<string, string> = {
  chinese: '中文',
  latin: '英文 西文',
  japanese: '日文',
  korean: '韩文',
  symbol: '符号',
  other: '其他语言',
  arabic: '阿拉伯文',
  hebrew: '希伯来文',
  thai: '泰文',
  cyrillic: '西里尔文',
  greek: '希腊文',
  devanagari: '天城文',
  bengali: '孟加拉文',
  tamil: '泰米尔文',
  telugu: '泰卢固文',
  gujarati: '古吉拉特文',
  gurmukhi: '古尔穆基文',
  lao: '老挝文',
  khmer: '高棉文',
  myanmar: '缅甸文',
  ethiopic: '埃塞俄比亚文',
  armenian: '亚美尼亚文',
  georgian: '格鲁吉亚文',
  vietnamese: '越南文',
}

const CATEGORY_LABELS: Record<string, string> = {
  serif: '衬线 宋体 明体',
  slabSerif: '粗衬线',
  sansSerif: '无衬线 黑体',
  script: '连笔 草书 花体',
  monospace: '等宽 代码',
  handwriting: '手写',
  hei: '黑体',
  art: '艺术 装饰 标题 海报',
}

function cleanText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function cleanArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanText(item)).filter(Boolean)
    : []
}

function normalizeFormat(value: unknown): string {
  const raw = cleanText(value).toLowerCase()
  if (raw === 'ttf' || raw.includes('truetype')) return 'ttf'
  if (raw === 'otf' || raw.includes('opentype')) return 'otf'
  if (raw === 'ttc') return 'ttc'
  if (raw === 'otc') return 'otc'
  return raw || 'unknown'
}

export function buildMergedIndexSearchText(
  font: Partial<FontItem> | Record<string, unknown>,
  options: { rootPath?: string; relativePath?: string; category?: string } = {},
): string {
  const scripts = cleanArray((font as any).scripts)
  const tagNames = cleanArray((font as any).tagNames)
  const collectionIds = cleanArray((font as any).collectionIds)
  const format = normalizeFormat((font as any).format)
  const category = options.category || inferMergedIndexCategory(font)
  const scriptText = scripts.flatMap((script) => [script, SCRIPT_LABELS[script] || '']).join(' ')
  const installText = (font as any).systemInstalled ? '已安装 installed system' : '未安装 not installed'
  const protectionText = (font as any).deleteProtected ? '保护 不可删除 删除保护 protected' : ''
  const systemText = (font as any).systemImported ? '系统字体 system font' : ''
  const fields = [
    (font as any).fileName,
    (font as any).family,
    (font as any).fullName,
    (font as any).postscriptName,
    (font as any).style,
    (font as any).path,
    options.rootPath,
    options.relativePath,
    format,
    format.toUpperCase(),
    category,
    CATEGORY_LABELS[category] || category,
    scriptText,
    tagNames.join(' '),
    collectionIds.join(' '),
    installText,
    protectionText,
    systemText,
  ].map(cleanText).filter(Boolean)
  return Array.from(new Set(fields)).join(' ').toLowerCase()
}

export function buildMergedIndexSearchTextFromJson(
  fontJson?: string | null,
  options: { rootPath?: string; relativePath?: string; category?: string } = {},
): string {
  if (!fontJson) {
    return [options.rootPath, options.relativePath].map(cleanText).filter(Boolean).join(' ').toLowerCase()
  }
  try {
    const parsed = JSON.parse(fontJson)
    if (!parsed || typeof parsed !== 'object') {
      return [options.rootPath, options.relativePath].map(cleanText).filter(Boolean).join(' ').toLowerCase()
    }
    return buildMergedIndexSearchText(parsed as Record<string, unknown>, options)
  } catch {
    return [options.rootPath, options.relativePath].map(cleanText).filter(Boolean).join(' ').toLowerCase()
  }
}
