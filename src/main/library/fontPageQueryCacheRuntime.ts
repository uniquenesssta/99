import type { FontQueryPageResult,FontQueryRequest } from "../../shared/types";
import { fontQueryCacheKey } from "./fontQuerySqlRuntime";

type FontQueryPageCacheEntry = { at: number; result: FontQueryPageResult };

export type FontPageQueryCacheRuntimeOptions = {
  pageCacheMax: number;
  pageCacheTtlMs: number;
  queryUncached: (
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ) => Promise<FontQueryPageResult>;
  appendStartupLog: (message: string) => void;
  cacheKeySuffix?: (request: FontQueryRequest) => string;
};

export function createFontPageQueryCacheRuntime(
  options: FontPageQueryCacheRuntimeOptions,
) {
  const fontQueryPageResultCache = new Map<string, FontQueryPageCacheEntry>();
  const fontQueryPageInFlight = new Map<string, Promise<FontQueryPageResult>>();
  let cacheGeneration = 0;

  function invalidateFontQueryPageCache(): void {
    cacheGeneration += 1;
    fontQueryPageResultCache.clear();
    fontQueryPageInFlight.clear();
  }

  function rememberFontQueryPageResult(
    cacheKey: string,
    result: FontQueryPageResult,
  ): void {
    fontQueryPageResultCache.set(cacheKey, { at: Date.now(), result });
    if (fontQueryPageResultCache.size > options.pageCacheMax) {
      const oldest = Array.from(fontQueryPageResultCache.entries())
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, fontQueryPageResultCache.size - options.pageCacheMax);
      for (const [key] of oldest) fontQueryPageResultCache.delete(key);
    }
  }

  async function queryFontPageInLibrary(
    requestInput: FontQueryRequest,
  ): Promise<FontQueryPageResult> {
    const request = requestInput || {};
    const limit = Math.max(1, Math.min(500, Number(request.limit || 200) || 200));
    const offset = Math.max(0, Number(request.offset || 0) || 0);
    const baseCacheKey = fontQueryCacheKey({ ...request, limit, offset });
    const suffix = options.cacheKeySuffix?.(request) || '';
    const cacheKey = suffix ? `${baseCacheKey}:${suffix}` : baseCacheKey;
    const cached = fontQueryPageResultCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.at < options.pageCacheTtlMs) {
      cached.at = now;
      return { ...cached.result, elapsedMs: 0 };
    }

    const existing = fontQueryPageInFlight.get(cacheKey);
    if (existing) {
      options.appendStartupLog(
        `font page query joined in-flight: offset=${offset}, limit=${limit}, page=${request.sidebarPage || "library"}, activeFilter=${request.activeFilter?.kind || "all"}`,
      );
      return existing;
    }

    const requestGeneration = cacheGeneration;
    let promise!: Promise<FontQueryPageResult>;
    promise = options.queryUncached(request, limit, offset).then((result) => {
      if (requestGeneration === cacheGeneration) {
        rememberFontQueryPageResult(cacheKey, result);
      }
      return result;
    });
    fontQueryPageInFlight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      if (fontQueryPageInFlight.get(cacheKey) === promise) {
        fontQueryPageInFlight.delete(cacheKey);
      }
    }
  }

  return {
    invalidateFontQueryPageCache,
    queryFontPageInLibrary,
  };
}
