import type { FontItem,FontQueryRequest } from '../../shared/types'
import { fontFilterCacheKey } from './fontMemoryQueryCacheKeyRuntime'
import { createFontMemoryQueryMatcher } from './fontMemoryQueryMatcherRuntime'
import { compareSharedFonts } from './fontMemoryQuerySortRuntime'
import type { FontMemoryQueryRuntimeOptions,FontQueryResultCacheEntry } from './fontMemoryQueryTypes'
import { fontQueryNeedsFreshTagMetadata } from './tagQueryFreshnessRuntime'

export function createFontMemoryQueryRuntime(options: FontMemoryQueryRuntimeOptions) {
  const fontQueryResultCache = new Map<string, FontQueryResultCacheEntry>()
  const { sharedFontMatchesPathPrefixes, sharedFontMatchesRequest } = createFontMemoryQueryMatcher(options)
  let cacheGeneration = 0

  function invalidateFontQueryResultCache(): void {
    cacheGeneration += 1
    fontQueryResultCache.clear()
  }

  async function cleanSharedFontsForQuery(
    request: FontQueryRequest,
  ): Promise<FontItem[]> {
    const requestGeneration = cacheGeneration
    const folders = await options.appWatchedFolders()
    const cacheKey = fontFilterCacheKey(folders, request, options.normalizePathForCacheCompare)
    const now = Date.now()
    const freshMetadata = fontQueryNeedsFreshTagMetadata(request)
    const cached = freshMetadata ? undefined : fontQueryResultCache.get(cacheKey)
    if (cached && now - cached.at < options.resultCacheTtlMs) {
      cached.at = now
      return cached.items
    }

    const loadFonts = freshMetadata && options.loadSharedFontsForFoldersFresh
      ? options.loadSharedFontsForFoldersFresh
      : options.loadSharedFontsForFolders
    const allFonts = await options.hydrateLocalTagsForFonts(
      await loadFonts(folders),
    )
    const hydrated = await options.hydrateInstallStatusForFonts(allFonts)
    const items = hydrated
      .filter((font) => sharedFontMatchesRequest(font, request))
      .sort((a, b) => compareSharedFonts(a, b, request))
    if (freshMetadata) return items

    if (requestGeneration !== cacheGeneration) return items

    fontQueryResultCache.set(cacheKey, { at: now, items })
    if (fontQueryResultCache.size > options.resultCacheMax) {
      const oldest = Array.from(fontQueryResultCache.entries())
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, fontQueryResultCache.size - options.resultCacheMax)
      for (const [key] of oldest) fontQueryResultCache.delete(key)
    }
    return items
  }

  return {
    invalidateFontQueryResultCache,
    sharedFontMatchesPathPrefixes,
    compareSharedFonts,
    cleanSharedFontsForQuery,
  }
}

export type { FontMemoryQueryRuntimeOptions } from './fontMemoryQueryTypes'
