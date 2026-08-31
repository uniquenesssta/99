import { createHash } from 'node:crypto'
import { basename,extname,parse } from 'node:path'
import type { FontScript } from '../../../shared/types/fontTypes'
import type { FontParseJob,FontParseWorkerResult,RustFontNameHint,RustFontScriptHint,RustFontStyleHint } from '../fontScanWorkers'

const KNOWN_FONT_SCRIPTS = new Set<FontScript>([
  'latin',
  'chinese',
  'japanese',
  'korean',
  'symbol',
  'other',
  'arabic',
  'hebrew',
  'thai',
  'cyrillic',
  'greek',
  'devanagari',
  'bengali',
  'tamil',
  'telugu',
  'gujarati',
  'gurmukhi',
  'lao',
  'khmer',
  'myanmar',
  'ethiopic',
  'armenian',
  'georgian',
  'vietnamese',
])

function sha1(value: string): string {
  return createHash('sha1').update(value).digest('hex')
}

function formatFromPath(filePath: string): 'ttf' | 'otf' | 'ttc' | 'otc' | 'unknown' {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.ttf') return 'ttf'
  if (ext === '.otf') return 'otf'
  if (ext === '.ttc') return 'ttc'
  if (ext === '.otc') return 'otc'
  return 'unknown'
}

function normalizeNameHint(input?: RustFontNameHint): { family: string; fullName: string; postscriptName: string; style: string } | null {
  if (!input) return null
  const style = String(input.displaySubfamily || input.preferredSubfamily || input.subfamilyName || '').trim()
  const postscriptName = String(input.postscriptName || '').trim()
  const rawFamily = String(input.displayFamily || input.preferredFamily || input.familyName || '').trim()
  const rawFullName = String(input.fullName || [rawFamily, style].filter(Boolean).join(' ') || rawFamily || postscriptName || '').trim()
  const family = rawFamily || rawFullName || postscriptName
  const fullName = rawFullName || family
  if (!family && !fullName && !postscriptName) return null
  return { family, fullName, postscriptName, style }
}

function normalizeScriptHint(input?: RustFontScriptHint): FontScript[] {
  if (!input || !Array.isArray(input.scripts)) return []
  const scripts = input.scripts
    .filter((script): script is string => typeof script === 'string')
    .map((script) => script.trim().toLowerCase())
    .filter((script): script is FontScript => KNOWN_FONT_SCRIPTS.has(script as FontScript))
  return Array.from(new Set(scripts))
}

function styleNameFromHint(styleHint: RustFontStyleHint | undefined, fallbackStyle: string): string {
  const base = String(fallbackStyle || '').trim()
  if (!styleHint) return base
  if (base) return base
  const parts: string[] = []
  const weight = Number(styleHint.weightClass || 0)
  if (weight >= 700 || styleHint.bold) parts.push('Bold')
  else if (weight > 0 && weight <= 300) parts.push('Light')
  if (styleHint.italic) parts.push('Italic')
  return parts.join(' ') || base
}

export function buildFontParseResultFromRustMetadata(
  job: FontParseJob,
  scriptDetectionVersion: number,
): FontParseWorkerResult | null {
  if (job.signatureValid === false) {
    return {
      ...job,
      status: 'bad',
      message: '不是有效字体签名，已跳过。',
    }
  }

  if (job.signatureValid !== true || !job.nameHint || !job.scriptHint) return null

  const names = normalizeNameHint(job.nameHint)
  const scripts = normalizeScriptHint(job.scriptHint)
  if (!names || !scripts.length) return null

  const id = sha1(`${(job.cacheKey || job.filePath).toLowerCase()}|${job.fileSize}|${Math.round(job.modifiedAt)}`)
  const style = styleNameFromHint(job.styleHint, names.style)
  const familyHint = job.familyHint
  const font = {
    id,
    path: job.filePath,
    fileName: basename(job.filePath),
    family: names.family || parse(job.filePath).name,
    fullName: names.fullName || names.family || parse(job.filePath).name,
    postscriptName: names.postscriptName || '',
    style,
    familyKey: familyHint?.familyKey,
    styleKey: familyHint?.styleKey,
    familySource: familyHint ? 'rust' as const : 'name' as const,
    format: (job.formatHint as 'ttf' | 'otf' | 'ttc' | 'otc' | 'unknown' | undefined) || formatFromPath(job.filePath),
    scripts,
    scriptVersion: scriptDetectionVersion,
    fileSize: job.fileSize,
    modifiedAt: job.modifiedAt,
    createdAt: job.createdAt,
    addedAt: new Date().toISOString(),
    favorite: false,
    collectionIds: [],
    tagNames: [],
    localTagNames: [],
    systemInstalled: false,
    systemInstallMatches: [],
    active: false,
    deleteProtected: false,
  }

  return {
    ...job,
    status: 'ok',
    font,
  }
}
