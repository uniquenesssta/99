import fs from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join, resolve } from 'node:path'
import type { FontItem } from '../../../shared/types'
import { DEFAULT_PREVIEW_TEXT, previewCacheKey } from './previewCacheKeyRuntime'
import { previewCacheIdentityForInstalledRoute, previewCacheStatForInstalledRoute, resolveInstalledFontPreviewRoute } from './previewInstalledFontRouteRuntime'
import { createCachedPreviewReadCoalescerRuntime } from './cachedPreviewReadCoalescerRuntime'
import { createCachedPreviewImageDataUriCacheRuntime } from './cachedPreviewImageDataUriCacheRuntime'
import { createCachedPreviewMissCacheRuntime } from './cachedPreviewMissCacheRuntime'

export function createCachedPreviewReadRuntime(args: {
  ensureWindows: () => void
  sha1: (value: string) => string
  previewCacheStorageForFont: (fontPath: string) => Promise<any>
  readPreviewCacheIndexStatus: (storage: any, key: string, outputPath: string) => Promise<string | null>
  readCachedPreviewImages: (items: FontItem[], text: string, fontSize?: number, width?: number, height?: number) => Promise<Record<string, string>>
}) {
  const { ensureWindows, sha1, previewCacheStorageForFont, readPreviewCacheIndexStatus, readCachedPreviewImages } = args
  const coalescer = createCachedPreviewReadCoalescerRuntime()
  const dataUriCache = createCachedPreviewImageDataUriCacheRuntime()
  const missCache = createCachedPreviewMissCacheRuntime()

  async function readCachedFontPreviewImage(
    item: FontItem,
    text: string,
    fontSize = 34,
    width = 520,
    height = 150
  ): Promise<string> {
    const normalizedText = text || DEFAULT_PREVIEW_TEXT
    const memoryKey = dataUriCache.keyForItem(item, normalizedText, fontSize, width, height)
    const memoryHit = dataUriCache.get(memoryKey)
    if (memoryHit) return memoryHit
    if (missCache.hasFreshMiss(memoryKey)) return ''

    return coalescer.readSingle(item, normalizedText, fontSize, width, height, async () => {
      try {
        const secondHit = dataUriCache.get(memoryKey)
        if (secondHit) {
          missCache.forget(memoryKey)
          return secondHit
        }
        if (missCache.hasFreshMiss(memoryKey)) return ''

        ensureWindows()
        const storage = await previewCacheStorageForFont(resolve(item.path))
        const installedRoute = resolveInstalledFontPreviewRoute(item)
        const stat = previewCacheStatForInstalledRoute(item, installedRoute)
        if (!stat) return ''
        const cacheIdentity = previewCacheIdentityForInstalledRoute(storage.identity, installedRoute)
        const key = previewCacheKey(sha1, cacheIdentity, stat.size, stat.mtimeMs, fontSize, width, height, normalizedText)
        const outputPath = join(storage.dir, `${key}.png`)
        const indexedStatus = await readPreviewCacheIndexStatus(storage, key, outputPath).catch(() => null)
        if (indexedStatus && indexedStatus !== 'ok') {
          missCache.rememberMiss(memoryKey)
          return ''
        }
        if (!fs.existsSync(outputPath)) {
          missCache.rememberMiss(memoryKey)
          return ''
        }
        const bytes = await fsp.readFile(outputPath)
        missCache.forget(memoryKey)
        return dataUriCache.remember(memoryKey, `data:image/png;base64,${bytes.toString('base64')}`)
      } catch {
        return ''
      }
    })
  }

  async function readCachedFontPreviewImages(
    items: FontItem[],
    text: string,
    fontSize = 34,
    width = 520,
    height = 150
  ): Promise<Record<string, string>> {
    const normalizedText = text || DEFAULT_PREVIEW_TEXT
    const result: Record<string, string> = {}
    const misses: FontItem[] = []

    for (const item of items || []) {
      if (!item?.id) continue
      const memoryKey = dataUriCache.keyForItem(item, normalizedText, fontSize, width, height)
      const memoryHit = dataUriCache.get(memoryKey)
      if (memoryHit) {
        missCache.forget(memoryKey)
        result[item.id] = memoryHit
      } else if (!missCache.hasFreshMiss(memoryKey)) {
        misses.push(item)
      }
    }

    if (!misses.length) return result

    const loaded = await coalescer.readBatch(misses, normalizedText, fontSize, width, height, async (batchItems) => {
      try {
        ensureWindows()
        const freshResult: Record<string, string> = {}
        const freshMisses: FontItem[] = []
        for (const item of batchItems) {
          const memoryKey = dataUriCache.keyForItem(item, normalizedText, fontSize, width, height)
          const memoryHit = dataUriCache.get(memoryKey)
          if (memoryHit) {
            missCache.forget(memoryKey)
            freshResult[item.id] = memoryHit
          } else if (!missCache.hasFreshMiss(memoryKey)) {
            freshMisses.push(item)
          }
        }
        if (freshMisses.length) {
          const diskResult = await readCachedPreviewImages(freshMisses, normalizedText, fontSize, width, height)
          const memoryEntries: Array<{ key: string; dataUri: string }> = []
          const missedKeys: string[] = []
          for (const item of freshMisses) {
            const key = dataUriCache.keyForItem(item, normalizedText, fontSize, width, height)
            const dataUri = diskResult[item.id]
            if (!dataUri) {
              missedKeys.push(key)
              continue
            }
            missCache.forget(key)
            memoryEntries.push({
              key,
              dataUri
            })
            freshResult[item.id] = dataUri
          }
          dataUriCache.rememberMany(memoryEntries)
          missCache.rememberMisses(missedKeys)
        }
        return freshResult
      } catch {
        return {}
      }
    })

    return { ...result, ...loaded }
  }

  return { readCachedFontPreviewImage, readCachedFontPreviewImages }
}
