import { basename } from 'node:path'
import type { FontItem } from '../../../shared/types'
import { cacheKeyForPath,fileCacheSignature } from '../../cache/cachePaths'
import type { CachedFontStatLike } from '../../fonts/fontRuntime'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import type { FontParseJob } from '../fontScanWorkers'
import type { FontScanCacheEntry,FontScanCacheFile } from '../rootIndexRuntime'
import { cacheEntryContentHashMatches,withScanContentHash } from './scanContentHashRuntime'
import type { ScanStatJob } from './scanListingRuntime'
import type { ScanOrchestratorDeps } from './scanOrchestratorTypes'

export type ScanIncrementalDecisionSource = 'known' | 'root-cache' | 'legacy-cache' | 'rust-signature'

export type ScanIncrementalDecision =
  | { action: 'skip-bad'; source: 'rust-signature' | 'legacy-cache'; entry: FontScanCacheEntry }
  | { action: 'reuse-font'; source: 'known' | 'root-cache' | 'legacy-cache'; font: FontItem; entry: FontScanCacheEntry }
  | { action: 'parse'; reason: 'missing-manifest' | 'changed-file' | 'missing-script-metadata' | 'bad-cache-untrusted'; job: FontParseJob }

export interface ScanIncrementalDecisionInput {
  item: ScanStatJob
  file: string
  rootPath: string
  stat: CachedFontStatLike
  createdAt: number
  rootCacheKey: string
  signature: string
  contentHash?: string
  cached?: FontScanCacheEntry
}

export interface ScanIncrementalDecisionRuntime {
  decide: (input: ScanIncrementalDecisionInput) => Promise<ScanIncrementalDecision>
}

function hasCurrentScriptMetadata(font: FontItem | undefined, scriptDetectionVersion: number): font is FontItem {
  return Boolean(
    font &&
      Array.isArray(font.scripts) &&
      font.scripts.length &&
      font.scriptVersion === scriptDetectionVersion,
  )
}

function buildOkEntry(args: {
  font: FontItem
  rootCacheKey: string
  file: string
  stat: CachedFontStatLike
  signature: string
  contentHash?: string
  sanitizeCachedFont: ScanOrchestratorDeps['sanitizeCachedFont']
}): FontScanCacheEntry {
  return withScanContentHash({
    path: args.rootCacheKey,
    cacheKey: args.signature,
    fileSize: args.stat.size,
    modifiedAt: args.stat.mtimeMs,
    createdAt: args.stat.birthtimeMs || args.stat.ctimeMs || args.stat.mtimeMs,
    status: 'ok',
    font: args.sanitizeCachedFont(args.font, args.rootCacheKey, args.file, args.stat),
    cachedAt: new Date().toISOString(),
  }, args.contentHash)
}

function buildBadEntry(args: {
  rootCacheKey: string
  stat: CachedFontStatLike
  createdAt: number
  signature: string
  message: string
  contentHash?: string
}): FontScanCacheEntry {
  return withScanContentHash({
    path: args.rootCacheKey,
    cacheKey: args.signature,
    fileSize: args.stat.size,
    modifiedAt: args.stat.mtimeMs,
    createdAt: args.createdAt,
    status: 'bad',
    message: args.message,
    cachedAt: new Date().toISOString(),
  }, args.contentHash)
}

function runtimeKnownFont(known: FontItem, file: string, stat: CachedFontStatLike, createdAt: number): FontItem {
  return {
    ...known,
    path: file,
    fileName: basename(file),
    fileSize: stat.size,
    modifiedAt: stat.mtimeMs,
    createdAt,
    active: false,
    activeSince: undefined,
  }
}

function buildParseJob(input: ScanIncrementalDecisionInput): FontParseJob {
  return {
    jobId: '0',
    rootPath: input.rootPath,
    filePath: input.file,
    fileSize: input.stat.size,
    modifiedAt: input.stat.mtimeMs,
    createdAt: input.createdAt,
    cacheKey: input.rootCacheKey,
    signature: input.signature,
    signatureValid: input.item.signatureValid,
    formatHint: input.item.formatHint,
    quickHash: input.item.quickHash,
    contentHash: input.contentHash,
    hashKind: input.item.hashKind,
    nameHint: input.item.nameHint,
    scriptHint: input.item.scriptHint,
    styleHint: input.item.styleHint,
    familyHint: input.item.familyHint,
  }
}

export function createScanIncrementalDecisionRuntime(options: {
  deps: Pick<ScanOrchestratorDeps, 'cachedFontForRuntime' | 'sanitizeCachedFont' | 'scriptDetectionVersion'>
  knownFonts?: FontItem[]
  ensureLegacyCacheLoaded: () => Promise<FontScanCacheFile>
}): ScanIncrementalDecisionRuntime {
  const knownByPath = new Map<string, FontItem>()
  for (const font of options.knownFonts || []) {
    if (!font?.path) continue
    knownByPath.set(normalizePathForCacheCompare(font.path), font)
  }

  async function decide(input: ScanIncrementalDecisionInput): Promise<ScanIncrementalDecision> {
    const { deps } = options
    const { item, file, stat, createdAt, rootCacheKey, signature, contentHash, cached } = input

    if (item.signatureValid === false) {
      return {
        action: 'skip-bad',
        source: 'rust-signature',
        entry: buildBadEntry({
          rootCacheKey,
          stat,
          createdAt,
          signature,
          message: 'Rust core 预探测：不是有效字体签名，已跳过。',
          contentHash,
        }),
      }
    }

    const known = knownByPath.get(normalizePathForCacheCompare(file))
    if (
      known &&
      known.fileSize === stat.size &&
      Math.round(known.modifiedAt || 0) === Math.round(stat.mtimeMs) &&
      cacheEntryContentHashMatches(cached, contentHash) &&
      hasCurrentScriptMetadata(known, deps.scriptDetectionVersion)
    ) {
      const font = runtimeKnownFont(known, file, stat, createdAt)
      return {
        action: 'reuse-font',
        source: 'known',
        font,
        entry: cached && cached.cacheKey === signature && cached.status === 'ok' && cached.font
          ? withScanContentHash(cached, contentHash)
          : buildOkEntry({ font, rootCacheKey, file, stat, signature, contentHash, sanitizeCachedFont: deps.sanitizeCachedFont }),
      }
    }

    if (cached && cached.cacheKey === signature && cacheEntryContentHashMatches(cached, contentHash)) {
      if (
        cached.status !== 'bad' &&
        hasCurrentScriptMetadata(cached.font, deps.scriptDetectionVersion)
      ) {
        const font = deps.cachedFontForRuntime(cached.font, file, stat, rootCacheKey)
        return {
          action: 'reuse-font',
          source: 'root-cache',
          font,
          entry: withScanContentHash(cached, contentHash),
        }
      }

      if (cached.status === 'bad') {
        return { action: 'parse', reason: 'bad-cache-untrusted', job: buildParseJob(input) }
      }

      return { action: 'parse', reason: 'missing-script-metadata', job: buildParseJob(input) }
    }

    const legacy = await options.ensureLegacyCacheLoaded()
    const legacyCacheKey = cacheKeyForPath(file)
    const legacySignature = fileCacheSignature(legacyCacheKey, stat.size, stat.mtimeMs)
    const legacyCached = legacy.entries[legacyCacheKey]

    if (legacyCached && legacyCached.cacheKey === legacySignature) {
      if (legacyCached.status === 'bad') {
        return {
          action: 'skip-bad',
          source: 'legacy-cache',
          entry: buildBadEntry({
            rootCacheKey,
            stat,
            createdAt,
            signature,
            message: legacyCached.message || '不是有效字体签名，已跳过。',
            contentHash,
          }),
        }
      }

      if (hasCurrentScriptMetadata(legacyCached.font, deps.scriptDetectionVersion)) {
        const font = deps.cachedFontForRuntime(legacyCached.font, file, stat, rootCacheKey)
        return {
          action: 'reuse-font',
          source: 'legacy-cache',
          font,
          entry: buildOkEntry({ font, rootCacheKey, file, stat, signature, contentHash, sanitizeCachedFont: deps.sanitizeCachedFont }),
        }
      }
    }

    return {
      action: 'parse',
      reason: cached ? 'changed-file' : 'missing-manifest',
      job: buildParseJob(input),
    }
  }

  return { decide }
}
