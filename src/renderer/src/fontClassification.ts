import type { FontItem,FontScript } from '@shared/types'
import { FONT_CATEGORY_FILTERS,FONT_CATEGORY_LABELS,SCRIPT_LANGUAGE_LABELS,SCRIPT_LANGUAGE_ORDER } from './appConstants'
import type { FontCategory } from './appTypes'

export function inferFontScriptsFromMetadata(font: FontItem): FontScript[] {
  const text = [
    font.fileName,
    font.path,
    font.family,
    font.fullName,
    font.postscriptName,
    font.style,
    ...(font.tagNames || []),
    ...(font.localTagNames || [])
  ].join(' ').toLowerCase()

  const scripts = new Set<FontScript>()

  if (/[\u3040-\u30ff]/.test(text) || /(meiryo|yugoth|yu gothic|yu mincho|msgothic|ms gothic|msmincho|ms mincho|noto sans jp|source han sans jp|source han serif jp|japanese|jp\b)/i.test(text)) scripts.add('japanese')
  if (/[\uac00-\ud7af]/.test(text) || /(malgun|batang|gulim|dotum|gungsuh|korean|hangul|noto sans kr|source han sans kr|source han serif kr|kr\b)/i.test(text)) scripts.add('korean')
  if (/[\u4e00-\u9fff]/.test(text) || /(yahei|simsun|simhei|fangsong|kaiti|songti|heiti|microsoft yahei|microsoft jhenghei|mingliu|pmingliu|dengxian|noto sans cjk sc|noto sans cjk tc|source han sans sc|source han sans tc|source han serif sc|source han serif tc|chinese|zh|cn\b|tw\b|hk\b|简体|繁體|中文|宋体|黑体|仿宋|楷体|雅黑|明体|明朝)/i.test(text)) scripts.add('chinese')
  if (/(symbol|wingdings|webdings|icons?|emoji|marlett|mdls?2|fluent icons?|assets)/i.test(text)) scripts.add('symbol' as FontScript)
  if (/[\u0600-\u06ff]/.test(text) || /(arabic|arab)/i.test(text)) scripts.add('arabic' as FontScript)
  if (/[\u0590-\u05ff]/.test(text) || /hebrew/i.test(text)) scripts.add('hebrew' as FontScript)
  if (/[\u0e00-\u0e7f]/.test(text) || /thai/i.test(text)) scripts.add('thai' as FontScript)
  if (/[\u0400-\u04ff]/.test(text) || /(cyrillic|russian|ukrainian)/i.test(text)) scripts.add('cyrillic' as FontScript)
  if (/[\u0370-\u03ff]/.test(text) || /greek/i.test(text)) scripts.add('greek' as FontScript)
  if (/[\u0900-\u097f]/.test(text) || /(devanagari|hindi|sanskrit)/i.test(text)) scripts.add('devanagari' as FontScript)
  if (/[\u0980-\u09ff]/.test(text) || /bengali/i.test(text)) scripts.add('bengali' as FontScript)
  if (/[\u0b80-\u0bff]/.test(text) || /tamil/i.test(text)) scripts.add('tamil' as FontScript)
  if (/[\u0c00-\u0c7f]/.test(text) || /telugu/i.test(text)) scripts.add('telugu' as FontScript)
  if (/[\u0a80-\u0aff]/.test(text) || /gujarati/i.test(text)) scripts.add('gujarati' as FontScript)
  if (/[\u0a00-\u0a7f]/.test(text) || /gurmukhi|punjabi/i.test(text)) scripts.add('gurmukhi' as FontScript)
  if (/[\u0e80-\u0eff]/.test(text) || /lao/i.test(text)) scripts.add('lao' as FontScript)
  if (/[\u1780-\u17ff]/.test(text) || /khmer/i.test(text)) scripts.add('khmer' as FontScript)
  if (/[\u1000-\u109f]/.test(text) || /myanmar|burmese/i.test(text)) scripts.add('myanmar' as FontScript)
  if (/[\u1200-\u137f]/.test(text) || /ethiopic|amharic/i.test(text)) scripts.add('ethiopic' as FontScript)
  if (/[\u0530-\u058f]/.test(text) || /armenian/i.test(text)) scripts.add('armenian' as FontScript)
  if (/[\u10a0-\u10ff]/.test(text) || /georgian/i.test(text)) scripts.add('georgian' as FontScript)
  if (/tiếng việt|vietnamese|viet/i.test(text)) scripts.add('vietnamese' as FontScript)
  if (!scripts.size && /[a-z]/i.test(text)) scripts.add('latin')

  return Array.from(scripts)
}

export function rawFontScripts(font: FontItem): FontScript[] {
  const stored = Array.isArray(font.scripts)
    ? font.scripts.filter((script): script is FontScript => typeof script === 'string' && !!SCRIPT_LANGUAGE_LABELS[script])
    : []

  return stored.length ? stored : inferFontScriptsFromMetadata(font)
}

export function fontScripts(font: FontItem): FontScript[] {
  const raw = Array.from(new Set(rawFontScripts(font)))
  const text = [font.fileName, font.path, font.family, font.fullName, font.postscriptName, font.style].join(' ').toLowerCase()

  const forced: FontScript[] = []
  if (/[\u3040-\u30ff]/.test(text) || /(japanese|jp\b|meiryo|yugoth|yu gothic|msgothic|ms gothic|msmincho|ms mincho|noto sans jp|source han sans jp)/i.test(text)) forced.push('japanese')
  if (/[\uac00-\ud7af]/.test(text) || /(korean|kr\b|hangul|malgun|batang|gulim|dotum|noto sans kr|source han sans kr)/i.test(text)) forced.push('korean')
  if (/(chinese|zh|cn\b|tw\b|hk\b|yahei|simsun|simhei|fangsong|kaiti|songti|heiti|microsoft jhenghei|mingliu|pmingliu|dengxian|noto sans cjk sc|noto sans cjk tc|source han sans sc|source han sans tc|中文|简体|繁體|宋体|黑体|仿宋|楷体|雅黑|明体|明朝)/i.test(text)) forced.push('chinese')
  if (/(symbol|wingdings|webdings|icons?|emoji|marlett|mdls?2|fluent icons?|assets)/i.test(text)) forced.push('symbol' as FontScript)

  const preferred = forced.length ? Array.from(new Set(forced)) : raw
  const nonLatin = preferred.filter((script) => script !== 'latin')

  // 中文字体、日文字体、韩文字体通常都包含 Latin 字符。
  // 为了筛选更严格，只要识别到非 Latin/符号文字，就不把它算作英文/西文。
  const finalScripts = nonLatin.length ? nonLatin : preferred
  return SCRIPT_LANGUAGE_ORDER.filter((script) => finalScripts.includes(script as FontScript)) as FontScript[]
}

export function scriptLabels(font: FontItem): string[] {
  return fontScripts(font).map((script) => SCRIPT_LANGUAGE_LABELS[script] || script)
}

export function fontCategoryText(font: FontItem): string {
  return [
    font.fileName,
    font.path,
    font.family,
    font.fullName,
    font.postscriptName,
    font.style,
    ...(font.tagNames || []),
    ...(font.localTagNames || [])
  ].join(' ').toLowerCase()
}

export function inferFontCategory(font: FontItem): FontCategory {
  const text = fontCategoryText(font)

  // 顺序很重要：更明确的分类先匹配，避免“黑体”被普通无衬线提前吃掉。
  const priority: FontCategory[] = ['monospace', 'handwriting', 'script', 'slabSerif', 'hei', 'serif', 'sansSerif', 'art']

  for (const category of priority) {
    const config = FONT_CATEGORY_FILTERS.find((item) => item.id === category)
    if (!config) continue

    if (config.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) {
      return category
    }
  }

  if (fontScripts(font).some((script) => script === 'chinese' || script === 'japanese' || script === 'korean')) {
    return 'sansSerif'
  }

  return 'sansSerif'
}

export function fontCategoryLabel(font: FontItem): string {
  return FONT_CATEGORY_LABELS[inferFontCategory(font)] || '无衬线'
}

export function fontMatchesCategory(font: FontItem, category: FontCategory): boolean {
  if (category === 'all') return true
  return inferFontCategory(font) === category
}
