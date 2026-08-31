import { resolve } from 'node:path'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import type { RootScanCacheContext } from '../../watcher/watchedFolderIndexRuntime'
import type { FontScanCacheEntry,FontScanCacheFile } from '../rootIndexRuntime'
import type { ScanOrchestratorDeps } from './scanOrchestratorTypes'

export interface ScanRootCacheContextRuntime {
  rootCacheContexts: Map<string, RootScanCacheContext>
  ensureRootContext: (rootPath: string) => Promise<RootScanCacheContext>
  ensureLegacyCacheLoaded: () => Promise<FontScanCacheFile>
  rememberEntry: (context: RootScanCacheContext, cacheKey: string, entry: FontScanCacheEntry) => void
}

export function createScanRootCacheContextRuntime(deps: ScanOrchestratorDeps): ScanRootCacheContextRuntime {
  const rootCacheContexts = new Map<string, RootScanCacheContext>()
  let legacyCache: FontScanCacheFile | null = null

  async function ensureRootContext(rootPath: string): Promise<RootScanCacheContext> {
    const resolvedRoot = resolve(rootPath)
    const rootKey = normalizePathForCacheCompare(resolvedRoot)
    const existing = rootCacheContexts.get(rootKey)
    if (existing) return existing

    const storage = await deps.ensureRootScanCacheStorage(resolvedRoot)
    const context: RootScanCacheContext = {
      rootPath: resolvedRoot,
      cachePath: storage.cachePath,
      cacheDir: storage.cacheDir,
      storage: storage.storage,
      cache: storage.cache,
      nextEntries: {},
      seenKeys: new Set<string>(),
      directoryUpdates: [],
      directorySkipped: 0,
    }
    rootCacheContexts.set(rootKey, context)
    return context
  }

  async function ensureLegacyCacheLoaded(): Promise<FontScanCacheFile> {
    if (legacyCache) return legacyCache
    legacyCache = await deps.loadLegacyScanCache()
    return legacyCache
  }

  function rememberEntry(context: RootScanCacheContext, cacheKey: string, entry: FontScanCacheEntry): void {
    context.seenKeys.add(cacheKey)
    context.nextEntries[cacheKey] = entry
  }

  return {
    rootCacheContexts,
    ensureRootContext,
    ensureLegacyCacheLoaded,
    rememberEntry,
  }
}
