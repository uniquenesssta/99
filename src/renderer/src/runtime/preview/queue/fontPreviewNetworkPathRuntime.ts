import type { FontItem } from '@shared/types'

export function isLikelyNetworkFontPath(filePath?: string): boolean {
  const value = String(filePath || '').trim()
  if (!value) return false
  return value.startsWith('\\')
}

export function hasNetworkFontPath(fonts: FontItem[]): boolean {
  return (fonts || []).some((font) => isLikelyNetworkFontPath(font?.path))
}

export function networkAwarePreviewLimit(fonts: FontItem[], defaultLimit: number, networkLimit = 1): number {
  if (!hasNetworkFontPath(fonts)) return defaultLimit
  return Math.max(1, Math.min(defaultLimit, networkLimit))
}
