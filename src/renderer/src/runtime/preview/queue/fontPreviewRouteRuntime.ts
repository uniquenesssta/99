import type { FontItem } from '@shared/types'

export type FontPreviewRouteKind = 'installed-system-native' | 'file-webfont-then-native'

export interface FontPreviewRouteDecision {
  kind: FontPreviewRouteKind
  reason: 'systemInstalled' | 'active' | 'systemImported' | 'matched' | 'file'
  shouldSkipWebFontFileLoad: boolean
}

export function resolveFontPreviewRoute(font: FontItem): FontPreviewRouteDecision {
  if (font.systemInstalled) {
    return { kind: 'installed-system-native', reason: 'systemInstalled', shouldSkipWebFontFileLoad: true }
  }
  if (font.active) {
    return { kind: 'installed-system-native', reason: 'active', shouldSkipWebFontFileLoad: true }
  }
  if (font.systemImported) {
    return { kind: 'installed-system-native', reason: 'systemImported', shouldSkipWebFontFileLoad: true }
  }
  if (Array.isArray(font.systemInstallMatches) && font.systemInstallMatches.length > 0) {
    return { kind: 'installed-system-native', reason: 'matched', shouldSkipWebFontFileLoad: true }
  }
  return { kind: 'file-webfont-then-native', reason: 'file', shouldSkipWebFontFileLoad: false }
}

export function isInstalledSystemPreviewRoute(font: FontItem): boolean {
  return resolveFontPreviewRoute(font).kind === 'installed-system-native'
}
