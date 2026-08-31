import { basename,extname,parse } from 'node:path'
import type { FontItem } from '../../../shared/types'
import type { CachedFontStatLike } from '../../fonts/fontRuntime'
import type { ScanStatJob } from './scanListingRuntime'
import type { FontScanIncrementalChangeRuntime } from './fontScanIncrementalChangeRuntime'

export interface FontScanEarlyVisibleRuntime {
  enqueueListedBatch: (items: ScanStatJob[]) => void
  emittedCount: () => number
  cappedCount: () => number
}

function formatFromPath(filePath: string): FontItem['format'] {
  const ext = extname(filePath).toLowerCase()
  if (ext === '.ttf') return 'ttf'
  if (ext === '.otf') return 'otf'
  if (ext === '.ttc') return 'ttc'
  if (ext === '.otc') return 'otc'
  return 'unknown'
}

function createEarlyVisibleFont(filePath: string, stat: CachedFontStatLike): FontItem {
  const fallbackName = parse(filePath).name || basename(filePath)
  return {
    id: '',
    path: filePath,
    fileName: basename(filePath),
    family: fallbackName,
    fullName: fallbackName,
    postscriptName: '',
    style: 'Regular',
    familySource: 'fallback',
    format: formatFromPath(filePath),
    scripts: [],
    fileSize: stat.size,
    modifiedAt: stat.mtimeMs,
    createdAt: stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs,
    addedAt: new Date().toISOString(),
    favorite: false,
    collectionIds: [],
    tagNames: [],
    localTagNames: [],
    systemInstalled: false,
    installStatusKnown: false,
    systemInstallMatches: [],
    active: false,
    activeSince: undefined,
    deleteProtected: false,
    __earlyVisible: true,
  }
}

export function createFontScanEarlyVisibleRuntime(options: {
  cacheKeyForRootFile: (rootPath: string, filePath: string) => string
  cachedFontForRuntime: (font: FontItem, filePath: string, stat: CachedFontStatLike, cacheKey: string) => FontItem
  incrementalChanges: FontScanIncrementalChangeRuntime
  appendStartupLog: (message: string) => void
  maxFonts?: number
}): FontScanEarlyVisibleRuntime {
  const seen = new Set<string>()
  const maxFonts = Math.max(100, Math.floor(Number(options.maxFonts || 300)))
  let emitted = 0
  let capped = 0

  function enqueueListedBatch(items: ScanStatJob[]): void {
    for (const item of items) {
      if (!item?.file || !item.rootPath || !item.stat) continue
      if (emitted >= maxFonts) {
        capped += 1
        continue
      }
      const seenKey = `${item.rootPath}\n${item.file}`.toLowerCase()
      if (seen.has(seenKey)) continue
      seen.add(seenKey)
      const cacheKey = options.cacheKeyForRootFile(item.rootPath, item.file)
      const font = options.cachedFontForRuntime(createEarlyVisibleFont(item.file, item.stat), item.file, item.stat, cacheKey)
      options.incrementalChanges.enqueueUpsert(item.rootPath, font)
      emitted += 1
    }
  }

  return {
    enqueueListedBatch,
    emittedCount: () => emitted,
    cappedCount: () => capped,
  }
}
