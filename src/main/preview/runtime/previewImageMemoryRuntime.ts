import type { FontItem } from '../../../shared/types'
import { DEFAULT_PREVIEW_TEXT } from './previewCacheKeyRuntime'

export function createPreviewImageMemoryRuntime(limit = 160) {
  const inflight = new Map<string, Promise<string>>()
  const dataUriCache = new Map<string, string>()

  function requestKey(item: FontItem, text: string, fontSize: number, width: number, height: number): string {
    return `${item.id}|${item.path}|${item.fileSize || 0}|${item.modifiedAt || 0}|${fontSize}|${width}|${height}|${text || DEFAULT_PREVIEW_TEXT}`
  }

  function get(key: string): string {
    const cachedDataUri = dataUriCache.get(key)
    if (!cachedDataUri) return ''
    dataUriCache.delete(key)
    dataUriCache.set(key, cachedDataUri)
    return cachedDataUri
  }

  function remember(key: string, dataUri: string): string {
    if (dataUriCache.has(key)) dataUriCache.delete(key)
    dataUriCache.set(key, dataUri)
    while (dataUriCache.size > limit) {
      const oldest = dataUriCache.keys().next().value
      if (!oldest) break
      dataUriCache.delete(oldest)
    }
    return dataUri
  }

  return { inflight, requestKey, get, remember }
}
