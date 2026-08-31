import type { FontItem } from '../../../shared/types'
import { resolveInstalledFontPreviewRoute } from './previewInstalledFontRouteRuntime'

export type CachedPreviewImageDataUriCache = {
  keyForItem: (item: FontItem, text: string, fontSize: number, width: number, height: number) => string
  get: (key: string) => string
  remember: (key: string, dataUri: string) => string
  rememberMany: (entries: Array<{ key: string; dataUri: string }>) => void
}

const DEFAULT_LIMIT = 700

function itemSignature(item: FontItem): string {
  const installedRoute = item ? resolveInstalledFontPreviewRoute(item) : null
  return [
    item?.id || '',
    installedRoute?.cacheIdentity || item?.path || '',
    installedRoute ? 0 : Math.round(Number(item?.fileSize || 0)),
    installedRoute ? 0 : Math.round(Number(item?.modifiedAt || 0)),
  ].join('@')
}

export function createCachedPreviewImageDataUriCacheRuntime(limit = DEFAULT_LIMIT): CachedPreviewImageDataUriCache {
  const cache = new Map<string, string>()

  function prune(): void {
    while (cache.size > limit) {
      const oldest = cache.keys().next().value
      if (!oldest) break
      cache.delete(oldest)
    }
  }

  function keyForItem(item: FontItem, text: string, fontSize: number, width: number, height: number): string {
    return [itemSignature(item), text || '', fontSize, width, height].join('::')
  }

  function get(key: string): string {
    const value = cache.get(key)
    if (!value) return ''
    cache.delete(key)
    cache.set(key, value)
    return value
  }

  function remember(key: string, dataUri: string): string {
    if (!key || !dataUri) return dataUri || ''
    cache.delete(key)
    cache.set(key, dataUri)
    prune()
    return dataUri
  }

  function rememberMany(entries: Array<{ key: string; dataUri: string }>): void {
    for (const entry of entries) {
      if (!entry.key || !entry.dataUri) continue
      cache.delete(entry.key)
      cache.set(entry.key, entry.dataUri)
    }
    prune()
  }

  return { keyForItem, get, remember, rememberMany }
}
