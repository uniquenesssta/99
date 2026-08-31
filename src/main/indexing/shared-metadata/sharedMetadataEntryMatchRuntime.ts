import { basename } from 'node:path'
import type { FontItem } from '../../../shared/types'
import type { FontScanCacheEntry } from '../rootIndexRuntime'
import type { SharedMetadataCacheSource, SharedFontMetadataRuntimeDeps } from './sharedFontMetadataRuntime'

export type SharedMetadataMatchedEntry = {
  relativePath: string
  entry: FontScanCacheEntry
  font: FontItem
  synthetic: boolean
}

function normalizeRelativePath(value: string): string {
  return String(value || '').replace(/\\/g, '/')
}

function itemLooksUsableForSyntheticMetadata(item: FontItem): boolean {
  return Boolean(item?.id && item?.path)
}

function createSyntheticEntryForItem(
  runtimeDeps: SharedFontMetadataRuntimeDeps,
  rootPath: string,
  item: FontItem,
  relativePath: string,
): SharedMetadataMatchedEntry | null {
  if (!itemLooksUsableForSyntheticMetadata(item) || !relativePath) return null
  const runtimePath = runtimeDeps.cacheEntryRuntimePath(rootPath, relativePath)
  const font: FontItem = {
    ...item,
    path: item.path || runtimePath,
    fileName: item.fileName || basename(item.path || runtimePath),
    fileSize: Number(item.fileSize || 0),
    modifiedAt: Number(item.modifiedAt || 0),
    createdAt: item.createdAt,
  }
  const entry: FontScanCacheEntry = {
    path: relativePath,
    cacheKey: relativePath,
    fileSize: Number(font.fileSize || 0),
    modifiedAt: Number(font.modifiedAt || 0),
    createdAt: font.createdAt,
    status: 'ok',
    font,
    cachedAt: new Date().toISOString(),
  }
  return {
    relativePath: normalizeRelativePath(relativePath),
    entry,
    font,
    synthetic: true,
  }
}

export function findSharedMetadataMatchedEntry(
  runtimeDeps: SharedFontMetadataRuntimeDeps,
  rootPath: string,
  cacheSource: SharedMetadataCacheSource,
  item: FontItem,
): SharedMetadataMatchedEntry | null {
  const cache = cacheSource.cache
  const relativePath = item.path ? normalizeRelativePath(runtimeDeps.cacheKeyForRootFile(rootPath, item.path)) : ''
  let entry = relativePath ? cache.entries[relativePath] : undefined

  if (!entry?.font) {
    const normalizedItemPath = runtimeDeps.normalizePathForCacheCompare(item.path || '')
    const matched = Object.entries(cache.entries || {}).find(([, candidate]) => {
      if (candidate.status !== 'ok' || !candidate.font) return false
      if (candidate.font.id === item.id) return true
      const runtimePath = runtimeDeps.cacheEntryRuntimePath(rootPath, candidate.path || '')
      return runtimeDeps.normalizePathForCacheCompare(runtimePath) === normalizedItemPath
    })
    if (matched) {
      return {
        relativePath: normalizeRelativePath(matched[0]),
        entry: matched[1],
        font: matched[1].font!,
        synthetic: false,
      }
    }
  }

  if (entry?.font && relativePath) {
    return {
      relativePath: normalizeRelativePath(relativePath),
      entry,
      font: entry.font,
      synthetic: false,
    }
  }

  return createSyntheticEntryForItem(runtimeDeps, rootPath, item, relativePath)
}
