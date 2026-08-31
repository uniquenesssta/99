import type { FontItem } from '@shared/types'

export function formatSize(bytes: number): string {
  if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

export function fontDisplayName(font: FontItem): string {
  return font.family || font.fullName || font.fileName
}

export function fontFileDisplayName(font: FontItem): string {
  const fileName = (font.fileName || '').trim()
  if (!fileName) return fontDisplayName(font)
  return fileName.replace(/\.[^.\/]+$/, '')
}

export function fontPostScriptDisplayName(font: FontItem): string {
  return font.postscriptName || font.fullName || font.family || fontFileDisplayName(font)
}

export function isInstalled(font: FontItem): boolean {
  return !!font.systemInstalled
}

export function isInstallStatusKnown(font: FontItem): boolean {
  return font.installStatusKnown === true || !!font.systemInstalled || !!font.systemInstallMatches?.length
}

export function isSystemBuiltinFont(font: FontItem): boolean {
  const normalizedPath = font.path.replaceAll('/', '\\').toLowerCase()
  if (normalizedPath.includes('\\windows\\fonts\\')) return true

  return !!font.systemInstallMatches?.some((match) => {
    const matchPath = (match.path || match.value || '').replaceAll('/', '\\').toLowerCase()
    return match.source === 'HKLM' || matchPath.includes('\\windows\\fonts\\')
  })
}

export function isCleanWindowsDefaultFont(font: FontItem): boolean {
  return isSystemBuiltinFont(font)
}

export function installLabel(font: FontItem): string {
  if (font.systemInstalled && font.active) return '系统已安装 · 已激活'
  if (font.systemInstalled) return '系统已安装'
  if (font.active) return '已激活'
  return '未安装'
}
