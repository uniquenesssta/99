import { basename, extname } from 'node:path'
import type { FontItem } from '../../../shared/types'

export interface InstalledFontPreviewRoute {
  systemFontFamilyCandidates: string[]
  reason: 'systemInstalled' | 'active' | 'systemImported' | 'matched'
  cacheIdentity: string
}

const MAX_SYSTEM_FONT_CANDIDATES = 16

function cleanFontNameCandidate(value: unknown): string {
  const text = String(value || '')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/^['\"]+|['\"]+$/g, '')
    .trim()
  if (!text) return ''
  if (text.includes('\\') || text.includes('/')) return ''
  if (text.length > 160) return ''
  return text
}

function withoutFontExtension(value: unknown): string {
  const raw = cleanFontNameCandidate(value)
  if (!raw) return ''
  const extension = extname(raw)
  return extension ? raw.slice(0, -extension.length).trim() : raw
}

function registryNameToFamilyCandidate(value: unknown): string {
  return cleanFontNameCandidate(String(value || '').replace(/\s*\([^)]*\)\s*$/g, ''))
}

function fileNameToFamilyCandidate(value: unknown): string {
  const name = withoutFontExtension(basename(String(value || '')))
  if (!name) return ''
  return cleanFontNameCandidate(
    name
      .replace(/[._-]+regular$/i, '')
      .replace(/[._-]+(normal|medium|book)$/i, '')
      .replace(/[._-]+\d+$/g, '')
      .replace(/[._-]+/g, ' ')
  )
}

function pushCandidate(target: string[], seen: Set<string>, value: unknown): void {
  const candidate = cleanFontNameCandidate(value)
  if (!candidate) return
  const key = candidate.toLocaleLowerCase()
  if (seen.has(key)) return
  seen.add(key)
  target.push(candidate)
}

function routeCacheIdentity(candidates: string[]): string {
  return `system-installed:${candidates.map((value) => value.toLocaleLowerCase()).join('|')}`
}

export function resolveInstalledFontPreviewRoute(item: FontItem): InstalledFontPreviewRoute | null {
  const matches = Array.isArray(item.systemInstallMatches) ? item.systemInstallMatches : []
  const installed = !!item.systemInstalled || !!item.active || !!item.systemImported || matches.length > 0
  if (!installed) return null

  const candidates: string[] = []
  const seen = new Set<string>()
  pushCandidate(candidates, seen, item.family)
  pushCandidate(candidates, seen, item.fullName)
  pushCandidate(candidates, seen, item.postscriptName)
  pushCandidate(candidates, seen, fileNameToFamilyCandidate(item.fileName))
  pushCandidate(candidates, seen, fileNameToFamilyCandidate(item.path))

  for (const match of matches) {
    if (Array.isArray(match.nameCandidates)) {
      for (const name of match.nameCandidates) pushCandidate(candidates, seen, name)
    }
    pushCandidate(candidates, seen, registryNameToFamilyCandidate(match.registryName))
    pushCandidate(candidates, seen, fileNameToFamilyCandidate(match.fileName))
    pushCandidate(candidates, seen, fileNameToFamilyCandidate(match.path))
    pushCandidate(candidates, seen, fileNameToFamilyCandidate(match.value))
  }

  const limitedCandidates = candidates.slice(0, MAX_SYSTEM_FONT_CANDIDATES)
  if (!limitedCandidates.length) return null
  return {
    systemFontFamilyCandidates: limitedCandidates,
    reason: item.systemInstalled ? 'systemInstalled' : item.active ? 'active' : item.systemImported ? 'systemImported' : 'matched',
    cacheIdentity: routeCacheIdentity(limitedCandidates)
  }
}

export function previewCacheIdentityForInstalledRoute(baseIdentity: string, route: InstalledFontPreviewRoute | null): string {
  return route?.cacheIdentity || baseIdentity
}

export function previewCacheStatForInstalledRoute(item: FontItem, route: InstalledFontPreviewRoute | null, fallback?: { size: number; mtimeMs: number } | null): { size: number; mtimeMs: number } | null {
  if (route) return { size: 0, mtimeMs: 0 }
  if (fallback) return fallback
  if (item.fileSize > 0 && item.modifiedAt > 0) return { size: item.fileSize, mtimeMs: item.modifiedAt }
  return null
}
