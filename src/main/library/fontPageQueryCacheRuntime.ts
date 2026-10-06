import { createFontQueryTask, joinFontQueryTask, assertFontQueryActive, type FontQueryTask } from './fontQueryTaskRuntime';
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
  const fontQueryPageInFlight = new Map<string, FontQueryTask<FontQueryPageResult>>();
  let cacheGeneration = 0;

  function invalidateFontQueryPageCache(): void {
    cacheGeneration += 1;
    fontQueryPageResultCache.clear();
    for (const task of fontQueryPageInFlight.values()) task.controller.abort();
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
    assertFontQueryActive();
    const request = requestInput || {};
    const limit = Math.max(1, Math.min(500, Number(request.limit || 200) || 200));
    const offset = Math.max(0, Number(request.offset || 0) || 0);
    if (request.tagBindingsOnly) return options.queryUncached(request, limit, offset);
    const baseCacheKey = fontQueryCacheKey({ ...request, limit, offset });
    const suffix = options.cacheKeySuffix?.(request) || '';
    const cacheKey = suffix ? `${baseCacheKey}:${suffix}` : baseCacheKey;
    const cached = fontQueryPageResultCache.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.at < options.pageCacheTtlMs) {
      cached.at = now;
      return { ...cached.result, elapsedMs: 0 };
    }

    const joinedGeneration = cacheGeneration;
    const physicalKey = `${cacheGeneration}:${cacheKey}`;
    const existing = fontQueryPageInFlight.get(physicalKey);
    if (existing) {
      options.appendStartupLog(
        `font page query joined in-flight: offset=${offset}, limit=${limit}, page=${request.sidebarPage || "library"}, activeFilter=${request.activeFilter?.kind || "all"}`,
      );
      try { const result = await joinFontQueryTask(existing); assertFontQueryActive(); return joinedGeneration === cacheGeneration ? result : queryFontPageInLibrary(request); }
      catch (error) { assertFontQueryActive(); if (existing.controller.signal.aborted) return queryFontPageInLibrary(request); throw error; }
    }

    const requestGeneration = cacheGeneration;
    const task = createFontQueryTask(() => options.queryUncached(request, limit, offset));
    fontQueryPageInFlight.set(physicalKey, task);
    // Publish before removing the physical owner, even if its creator left
    // while another consumer remained subscribed.
    void task.pending.then(result => {
      if (requestGeneration === cacheGeneration && !task.controller.signal.aborted) rememberFontQueryPageResult(cacheKey, result);
    }).finally(() => {
      if (fontQueryPageInFlight.get(physicalKey) === task) fontQueryPageInFlight.delete(physicalKey);
    }).catch(() => undefined);
    try {
      const result = await joinFontQueryTask(task);
      assertFontQueryActive();
      if (requestGeneration !== cacheGeneration) return queryFontPageInLibrary(request);
      return result;
    } catch (error) {
      assertFontQueryActive();
      if (requestGeneration !== cacheGeneration) return queryFontPageInLibrary(request);
      throw error;
    }
  }

  return {
    invalidateFontQueryPageCache,
    queryFontPageInLibrary,
  };
}
