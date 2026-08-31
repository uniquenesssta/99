import type { FontItem,SystemInstalledFont } from '@shared/types'
import { fontDisplayName,fontFileDisplayName } from '../../appRuntime'

function cleanFamilyCandidate(value?: string): string {
  return String(value || '')
    .replace(/\.(ttf|otf|ttc|otc)$/i, '')
    .replace(/\s*\((TrueType|OpenType|Type 1|PostScript|Variable)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function pushCandidate(target: string[], seen: Set<string>, value?: string): void {
  const cleaned = cleanFamilyCandidate(value)
  if (!cleaned) return
  const key = cleaned.toLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  target.push(cleaned)
}

function registryCandidates(match: SystemInstalledFont): string[] {
  const result: string[] = []
  for (const candidate of match.nameCandidates || []) result.push(candidate)
  result.push(match.registryName)
  result.push(match.value)
  result.push(match.fileName || '')
  return result
}

function cssQuoteFamily(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildInstalledFontCssFamily(font: FontItem): string {
  const canUseSystemFamily = Boolean(font.systemInstalled || font.active || font.systemImported || font.systemInstallMatches?.length)
  if (!canUseSystemFamily) return ''

  const candidates: string[] = []
  const seen = new Set<string>()
  pushCandidate(candidates, seen, font.family)
  pushCandidate(candidates, seen, font.fullName)
  pushCandidate(candidates, seen, font.postscriptName)
  pushCandidate(candidates, seen, fontDisplayName(font))
  pushCandidate(candidates, seen, fontFileDisplayName(font))

  for (const match of font.systemInstallMatches || []) {
    for (const candidate of registryCandidates(match)) pushCandidate(candidates, seen, candidate)
  }

  if (!candidates.length) return ''
  return `${candidates.map(cssQuoteFamily).join(', ')}, serif`
}

export function buildListPreviewCssFamily(font: FontItem, previewFamily?: string): string {
  const loadedWebFamily = cleanFamilyCandidate(previewFamily)
  if (loadedWebFamily) return cssQuoteFamily(loadedWebFamily)
  return buildInstalledFontCssFamily(font)
}
