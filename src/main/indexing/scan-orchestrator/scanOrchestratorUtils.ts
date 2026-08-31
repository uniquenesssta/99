import { relative } from 'node:path'

export function delayToEventLoop(): Promise<void> {
  return new Promise((resolveDelay) => setImmediate(resolveDelay))
}

export function createFontScanJobId(): string {
  return `index-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function relativeDirectoryPathForRoot(rootPath: string, dirPath: string): string {
  const relativeDir = relative(rootPath, dirPath).replaceAll('\\', '/')
  if (!relativeDir || relativeDir === '.') return ''
  return relativeDir.toLowerCase().replace(/\/+$|\\+$/g, '')
}

export function normalizeDirectoryCacheKey(value: string): string {
  return String(value || '').replaceAll('\\', '/').toLowerCase().replace(/\/+$|\\+$/g, '')
}

export function cacheKeyInsideDirectory(cacheKey: string, relativeDir: string): boolean {
  const key = normalizeDirectoryCacheKey(cacheKey)
  const dir = normalizeDirectoryCacheKey(relativeDir)
  if (!dir) return true
  return key === dir || key.startsWith(`${dir}/`)
}

export function cacheKeyDirectlyInsideDirectory(cacheKey: string, relativeDir: string): boolean {
  const key = normalizeDirectoryCacheKey(cacheKey)
  const dir = normalizeDirectoryCacheKey(relativeDir)
  if (!dir) return Boolean(key) && !key.includes('/')
  if (!key.startsWith(`${dir}/`)) return false
  const rest = key.slice(dir.length + 1)
  return Boolean(rest) && !rest.includes('/')
}
