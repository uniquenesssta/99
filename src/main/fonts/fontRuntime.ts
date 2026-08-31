import * as fontkit from 'fontkit'
import crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename,extname,isAbsolute,join,parse } from 'node:path'
import type { FontFormat,FontItem,FontScript } from '../../shared/types'

const SCRIPT_DETECTION_VERSION = 2

export function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex')
}

export function asFormat(filePath: string): FontFormat {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.ttf') return 'ttf'
  if (ext === '.otf') return 'otf'
  if (ext === '.ttc') return 'ttc'
  if (ext === '.otc') return 'otc'
  return 'unknown'
}

export async function hasValidFontSignature(filePath: string): Promise<boolean> {
  try {
    const handle = await fsp.open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(4)
      const result = await handle.read(buffer, 0, 4, 0)
      if (result.bytesRead < 4) return false

      const hex = buffer.toString('hex')
      const ascii = buffer.toString('ascii')

      return (
        hex === '00010000' ||
        ascii === 'OTTO' ||
        ascii === 'ttcf' ||
        ascii === 'true' ||
        ascii === 'typ1'
      )
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

const FONT_SCRIPT_SAMPLES: Record<FontScript, number[]> = {
  latin: Array.from('AaZz0123456789').map((char) => char.codePointAt(0)!),
  chinese: Array.from('中文汉字国体的一').map((char) => char.codePointAt(0)!),
  japanese: Array.from('あいうえおアイウエオ日本語').map((char) => char.codePointAt(0)!),
  korean: Array.from('한글가나다라마바사').map((char) => char.codePointAt(0)!),
  symbol: Array.from('☑★♡←→').map((char) => char.codePointAt(0)!),
  other: [],
  arabic: Array.from('العربية').map((char) => char.codePointAt(0)!),
  hebrew: Array.from('עברית').map((char) => char.codePointAt(0)!),
  thai: Array.from('ภาษาไทย').map((char) => char.codePointAt(0)!),
  cyrillic: Array.from('Кириллица').map((char) => char.codePointAt(0)!),
  greek: Array.from('Ελληνικά').map((char) => char.codePointAt(0)!),
  devanagari: Array.from('हिन्दी').map((char) => char.codePointAt(0)!),
  bengali: Array.from('বাংলা').map((char) => char.codePointAt(0)!),
  tamil: Array.from('தமிழ்').map((char) => char.codePointAt(0)!),
  telugu: Array.from('తెలుగు').map((char) => char.codePointAt(0)!),
  gujarati: Array.from('ગુજરાતી').map((char) => char.codePointAt(0)!),
  gurmukhi: Array.from('ਪੰਜਾਬੀ').map((char) => char.codePointAt(0)!),
  lao: Array.from('ພາສາລາວ').map((char) => char.codePointAt(0)!),
  khmer: Array.from('ភាសាខ្មែរ').map((char) => char.codePointAt(0)!),
  myanmar: Array.from('မြန်မာ').map((char) => char.codePointAt(0)!),
  ethiopic: Array.from('አማርኛ').map((char) => char.codePointAt(0)!),
  armenian: Array.from('Հայերեն').map((char) => char.codePointAt(0)!),
  georgian: Array.from('ქართული').map((char) => char.codePointAt(0)!),
  vietnamese: Array.from('Tiếng Việt ăâêôơưđ').map((char) => char.codePointAt(0)!)
}

function fontHasCodePoint(font: unknown, codePoint: number): boolean {
  const item = font as {
    characterSet?: number[]
    hasGlyphForCodePoint?: (value: number) => boolean
    glyphForCodePoint?: (value: number) => { id?: number } | null
  }

  try {
    if (Array.isArray(item.characterSet) && item.characterSet.includes(codePoint)) return true
    if (typeof item.hasGlyphForCodePoint === 'function') return !!item.hasGlyphForCodePoint(codePoint)

    if (typeof item.glyphForCodePoint === 'function') {
      const glyph = item.glyphForCodePoint(codePoint)
      return !!glyph && typeof glyph.id === 'number' && glyph.id > 0
    }
  } catch {
    return false
  }

  return false
}

function openedFonts(opened: unknown): unknown[] {
  const source = opened as { fonts?: unknown[] }
  return Array.isArray(source?.fonts) && source.fonts.length ? source.fonts : [opened]
}

function collectCharacterSet(opened: unknown): Set<number> {
  const codePoints = new Set<number>()

  for (const font of openedFonts(opened)) {
    const item = font as { characterSet?: number[] }
    if (!Array.isArray(item.characterSet)) continue

    for (const value of item.characterSet) {
      if (Number.isInteger(value) && value >= 0) codePoints.add(value)
    }
  }

  return codePoints
}

function countCodePointsInRanges(codePoints: Set<number>, ranges: Array<[number, number]>): number {
  let count = 0
  for (const value of codePoints) {
    if (ranges.some(([start, end]) => value >= start && value <= end)) count += 1
  }
  return count
}

function hasAnySample(opened: unknown, samples: number[]): boolean {
  const fonts = openedFonts(opened)
  return samples.some((codePoint) => fonts.some((font) => fontHasCodePoint(font, codePoint)))
}

function detectFontScriptsFromOpened(opened: unknown, textHint = ''): FontScript[] {
  const hint = textHint.toLowerCase()
  const codePoints = collectCharacterSet(opened)
  const scripts = new Set<FontScript>()

  const latinCount = countCodePointsInRanges(codePoints, [[0x0020, 0x007e], [0x00a0, 0x024f]])
  const cjkCount = countCodePointsInRanges(codePoints, [[0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff]])
  const kanaCount = countCodePointsInRanges(codePoints, [[0x3040, 0x30ff], [0x31f0, 0x31ff]])
  const hangulCount = countCodePointsInRanges(codePoints, [[0x1100, 0x11ff], [0x3130, 0x318f], [0xac00, 0xd7af]])
  const symbolCount = countCodePointsInRanges(codePoints, [[0x2190, 0x27bf], [0xe000, 0xf8ff], [0x1f000, 0x1faff]])

  const hasJapaneseHint = /(meiryo|yugoth|yu gothic|yu mincho|msgothic|ms gothic|msmincho|ms mincho|noto sans jp|source han sans jp|source han serif jp|japanese|jp\b)/i.test(hint)
  const hasKoreanHint = /(malgun|batang|gulim|dotum|gungsuh|korean|hangul|noto sans kr|source han sans kr|source han serif kr|kr\b)/i.test(hint)
  const hasChineseHint = /(yahei|simsun|simhei|fangsong|kaiti|songti|heiti|microsoft yahei|microsoft jhenghei|mingliu|pmingliu|dengxian|noto sans cjk sc|noto sans cjk tc|source han sans sc|source han sans tc|source han serif sc|source han serif tc|chinese|zh|cn\b|tw\b|hk\b|简体|繁體|中文|宋体|黑体|仿宋|楷体|雅黑|明体|明朝)/i.test(hint)
  const hasSymbolHint = /(symbol|wingdings|webdings|icons?|emoji|marlett|mdls?2|fluent icons?|assets)/i.test(hint)

  const isJapanese = kanaCount >= 40 || hasJapaneseHint
  const isKorean = hangulCount >= 300 || hasKoreanHint
  const isChinese = hasChineseHint || (cjkCount >= 500 && !isJapanese && !isKorean)
  const isSymbol = hasSymbolHint || (symbolCount >= 80 && cjkCount < 20 && kanaCount < 20 && hangulCount < 20 && latinCount < 80)

  if (isChinese) scripts.add('chinese')
  if (isJapanese) scripts.add('japanese')
  if (isKorean) scripts.add('korean')
  if (isSymbol) scripts.add('symbol')

  for (const [script, samples] of Object.entries(FONT_SCRIPT_SAMPLES) as Array<[FontScript, number[]]>) {
    if (script === 'latin' || script === 'chinese' || script === 'japanese' || script === 'korean') continue
    if (script === 'symbol' || script === 'other') continue
    if (hasAnySample(opened, samples)) scripts.add(script)
  }

  // 中文、日文、韩文字体几乎都会带 Latin 字符。
  // 为了“英文/西文”筛选严格，不把已经识别为中日韩/符号的字体再算入英文。
  const hasStrictNonLatin = Array.from(scripts).some((script) => script !== 'latin')
  const hasLatinAlphabet = latinCount >= 52 || hasAnySample(opened, FONT_SCRIPT_SAMPLES.latin)
  if (!hasStrictNonLatin && hasLatinAlphabet) scripts.add('latin')

  if (!scripts.size && codePoints.size) scripts.add('other')

  return (Object.keys(FONT_SCRIPT_SAMPLES).concat(['symbol', 'other']) as FontScript[])
    .filter((script) => scripts.has(script))
}

function inferScriptsFromFontText(filePath: string, names: Pick<FontItem, 'family' | 'fullName' | 'postscriptName' | 'style'>): FontScript[] {
  const text = [
    filePath,
    names.family,
    names.fullName,
    names.postscriptName,
    names.style
  ].join(' ').toLowerCase()

  const scripts = new Set<FontScript>()

  if (/[\u3040-\u30ff]/.test(text) || /(meiryo|yugoth|yu gothic|yu mincho|msgothic|ms gothic|msmincho|ms mincho|noto sans jp|source han sans jp|source han serif jp|japanese|jp\b)/i.test(text)) scripts.add('japanese')
  if (/[\uac00-\ud7af]/.test(text) || /(malgun|batang|gulim|dotum|gungsuh|korean|hangul|noto sans kr|source han sans kr|source han serif kr|kr\b)/i.test(text)) scripts.add('korean')
  if (/[\u4e00-\u9fff]/.test(text) || /(yahei|simsun|simhei|fangsong|kaiti|songti|heiti|microsoft yahei|microsoft jhenghei|mingliu|pmingliu|dengxian|noto sans cjk sc|noto sans cjk tc|source han sans sc|source han sans tc|source han serif sc|source han serif tc|chinese|zh|cn\b|tw\b|hk\b|简体|繁體|中文|宋体|黑体|仿宋|楷体|雅黑|明体|明朝)/i.test(text)) scripts.add('chinese')
  if (/(symbol|wingdings|webdings|icons?|emoji|marlett|mdls?2|fluent icons?|assets)/i.test(text)) scripts.add('symbol')
  if (/[\u0600-\u06ff]/.test(text) || /(arabic|arab)/i.test(text)) scripts.add('arabic')
  if (/[\u0590-\u05ff]/.test(text) || /hebrew/i.test(text)) scripts.add('hebrew')
  if (/[\u0e00-\u0e7f]/.test(text) || /thai/i.test(text)) scripts.add('thai')
  if (/[\u0400-\u04ff]/.test(text) || /(cyrillic|russian|ukrainian)/i.test(text)) scripts.add('cyrillic')
  if (/[\u0370-\u03ff]/.test(text) || /greek/i.test(text)) scripts.add('greek')
  if (/[\u0900-\u097f]/.test(text) || /(devanagari|hindi|sanskrit)/i.test(text)) scripts.add('devanagari')
  if (/[\u0980-\u09ff]/.test(text) || /bengali/i.test(text)) scripts.add('bengali')
  if (/[\u0b80-\u0bff]/.test(text) || /tamil/i.test(text)) scripts.add('tamil')
  if (/[\u0c00-\u0c7f]/.test(text) || /telugu/i.test(text)) scripts.add('telugu')
  if (/[\u0a80-\u0aff]/.test(text) || /gujarati/i.test(text)) scripts.add('gujarati')
  if (/[\u0a00-\u0a7f]/.test(text) || /gurmukhi|punjabi/i.test(text)) scripts.add('gurmukhi')
  if (/[\u0e80-\u0eff]/.test(text) || /lao/i.test(text)) scripts.add('lao')
  if (/[\u1780-\u17ff]/.test(text) || /khmer/i.test(text)) scripts.add('khmer')
  if (/[\u1000-\u109f]/.test(text) || /myanmar|burmese/i.test(text)) scripts.add('myanmar')
  if (/[\u1200-\u137f]/.test(text) || /ethiopic|amharic/i.test(text)) scripts.add('ethiopic')
  if (/[\u0530-\u058f]/.test(text) || /armenian/i.test(text)) scripts.add('armenian')
  if (/[\u10a0-\u10ff]/.test(text) || /georgian/i.test(text)) scripts.add('georgian')
  if (/tiếng việt|vietnamese|viet/i.test(text)) scripts.add('vietnamese')

  const nonLatin = Array.from(scripts).some((script) => script !== 'latin')
  if (!nonLatin && /[a-z]/i.test(text)) scripts.add('latin')

  return Array.from(scripts)
}

export function readFontMetadata(filePath: string): Pick<FontItem, 'family' | 'fullName' | 'postscriptName' | 'style' | 'scripts' | 'scriptVersion'> {
  try {
    const opened = fontkit.openSync(filePath)
    const font = Array.isArray(opened?.fonts) ? opened.fonts[0] : opened

    const family = String(font?.familyName || font?.fullName || parse(filePath).name || '')
    const fullName = String(font?.fullName || family || parse(filePath).name || '')
    const postscriptName = String(font?.postscriptName || '')
    const style = String(font?.subfamilyName || font?.styleName || '')
    const names = { family, fullName, postscriptName, style }
    const detected = detectFontScriptsFromOpened(opened, [filePath, family, fullName, postscriptName, style].join(' '))
    const scripts = detected.length ? detected : inferScriptsFromFontText(filePath, names)

    return { ...names, scripts, scriptVersion: SCRIPT_DETECTION_VERSION }
  } catch {
    const fallback = parse(filePath).name
    const names = { family: fallback, fullName: fallback, postscriptName: '', style: '' }
    return { ...names, scripts: inferScriptsFromFontText(filePath, names), scriptVersion: SCRIPT_DETECTION_VERSION }
  }
}

export async function fontItemFromPath(filePath: string): Promise<FontItem> {
  const stat = await fsp.stat(filePath)
  const id = sha1(`${filePath.toLowerCase()}|${stat.size}|${Math.round(stat.mtimeMs)}`)
  const names = readFontMetadata(filePath)

  return {
    id,
    path: filePath,
    fileName: basename(filePath),
    ...names,
    format: asFormat(filePath),
    fileSize: stat.size,
    modifiedAt: stat.mtimeMs,
    createdAt: stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs,
    addedAt: new Date().toISOString(),
    favorite: false,
    collectionIds: [],
    tagNames: [],
    localTagNames: [],
    systemInstalled: false,
    systemInstallMatches: [],
    active: false,
    deleteProtected: false
  }
}


export interface CachedFontStatLike {
  size: number
  mtimeMs: number
  birthtimeMs?: number
  ctimeMs?: number
}


export function createCachedFontRuntime(deps: { sharedFontId: (cacheIdentity: string, size: number, mtimeMs: number) => string }) {
  function sanitizeCachedFont(font: FontItem, cacheKey: string, filePath: string, stat: CachedFontStatLike): FontItem {
    return {
      ...font,
      id: deps.sharedFontId(cacheKey, stat.size, stat.mtimeMs),
      path: cacheKey,
      fileName: basename(filePath),
      fileSize: stat.size,
      modifiedAt: stat.mtimeMs,
      createdAt: stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs,
      collectionIds: [],
      tagNames: [],
      localTagNames: [],
      installStatusKnown: false,
      systemInstalled: false,
      systemInstallMatches: [],
      active: false,
      activeSince: undefined,
      deleteProtected: false
    }
  }

  function cachedFontForRuntime(font: FontItem, filePath: string, stat: CachedFontStatLike, cacheKey?: string): FontItem {
    return {
      ...font,
      id: cacheKey ? deps.sharedFontId(cacheKey, stat.size, stat.mtimeMs) : font.id,
      path: filePath,
      fileName: basename(filePath),
      fileSize: stat.size,
      modifiedAt: stat.mtimeMs,
      createdAt: stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs,
      installStatusKnown: false,
      active: false,
      activeSince: undefined
    }
  }

  function cacheEntryRuntimePath(rootPath: string, entryPath: string): string {
    const clean = (entryPath || '').replaceAll('\\', '/')
    if (isAbsolute(entryPath) || /^[a-zA-Z]:[\\/]/.test(entryPath) || entryPath.startsWith('\\\\')) return entryPath
    return join(rootPath, ...clean.split('/').filter(Boolean))
  }

  return { sanitizeCachedFont, cachedFontForRuntime, cacheEntryRuntimePath }
}
