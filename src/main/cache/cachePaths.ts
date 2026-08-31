import { extname,join } from 'node:path'
import { normalizePathForCacheCompare,relativePathForRoot } from '../path/cachePath'
import {
LEGACY_ROOT_PREVIEW_CACHE_DIR_NAME,
LEGACY_ROOT_SCAN_CACHE_FILE_NAME,
LEGACY_ROOT_SCAN_CACHE_LOCK_FILE_NAME,
LOCAL_PREVIEW_CACHE_DIR_NAME,
PREVIEW_CACHE_DB_DIR_NAME,
PREVIEW_CACHE_DB_FILE_NAME,
PREVIEW_CACHE_IMAGES_DIR_NAME,
ROOT_CACHE_DIR_NAME,
ROOT_CACHE_LOCK_DIR_NAME,
ROOT_CACHE_MANIFEST_FILE_NAME,
ROOT_EVENTS_DB_FILE_NAME,
ROOT_HASH_DB_FILE_NAME,
ROOT_INDEX_DB_DIR_NAME,
ROOT_INDEX_DB_FILE_NAME,
ROOT_INDEX_LOCK_FILE_NAME,
ROOT_METRICS_DB_FILE_NAME,
ROOT_PREVIEW_CACHE_DIR_NAME,
ROOT_SCAN_CACHE_FILE_NAME,
ROOT_SCAN_CACHE_LOCK_FILE_NAME
} from './constants'

export interface CachePathHelperDeps {
  dataPath: (...segments: string[]) => string
  sha1: (input: string) => string
  fontExtensions: Set<string>
}

export function createCachePathHelpers(deps: CachePathHelperDeps) {
  const legacyScanCachePath = (): string => deps.dataPath('font-scan-cache.json')

  const fallbackCacheRootDir = (rootPath: string): string =>
    deps.dataPath('folder-scan-cache', deps.sha1(normalizePathForCacheCompare(rootPath)))

  const fallbackScanCachePath = (rootPath: string): string => join(fallbackCacheRootDir(rootPath), ROOT_SCAN_CACHE_FILE_NAME)
  const fallbackLegacyScanCachePath = (rootPath: string): string => join(fallbackCacheRootDir(rootPath), LEGACY_ROOT_SCAN_CACHE_FILE_NAME)
  const rootCacheDir = (rootPath: string): string => join(rootPath, ROOT_CACHE_DIR_NAME)
  const rootScanCachePath = (rootPath: string): string => join(rootCacheDir(rootPath), ROOT_SCAN_CACHE_FILE_NAME)
  const rootLegacyScanCachePath = (rootPath: string): string => join(rootCacheDir(rootPath), LEGACY_ROOT_SCAN_CACHE_FILE_NAME)
  const rootIndexDbDir = (rootPath: string): string => join(rootCacheDir(rootPath), ROOT_INDEX_DB_DIR_NAME)
  const rootIndexDbPath = (rootPath: string): string => join(rootIndexDbDir(rootPath), ROOT_INDEX_DB_FILE_NAME)
  const rootEventsDbPath = (rootPath: string): string => join(rootIndexDbDir(rootPath), ROOT_EVENTS_DB_FILE_NAME)
  const rootHashDbPath = (rootPath: string): string => join(rootIndexDbDir(rootPath), ROOT_HASH_DB_FILE_NAME)
  const rootMetricsDbPath = (rootPath: string): string => join(rootIndexDbDir(rootPath), ROOT_METRICS_DB_FILE_NAME)
  const rootCacheLockDir = (rootPath: string): string => join(rootCacheDir(rootPath), ROOT_CACHE_LOCK_DIR_NAME)
  const rootIndexLockPath = (rootPath: string): string => join(rootCacheLockDir(rootPath), ROOT_INDEX_LOCK_FILE_NAME)
  const fallbackIndexDbDir = (rootPath: string): string => join(fallbackCacheRootDir(rootPath), ROOT_INDEX_DB_DIR_NAME)
  const fallbackIndexDbPath = (rootPath: string): string => join(fallbackIndexDbDir(rootPath), ROOT_INDEX_DB_FILE_NAME)
  const rootPreviewCacheDir = (rootPath: string): string => join(rootPath, ROOT_PREVIEW_CACHE_DIR_NAME)
  const legacyRootPreviewCacheDir = (rootPath: string): string => join(rootCacheDir(rootPath), LEGACY_ROOT_PREVIEW_CACHE_DIR_NAME)
  const rootPreviewImageDir = (rootPath: string): string => join(rootPreviewCacheDir(rootPath), PREVIEW_CACHE_IMAGES_DIR_NAME)
  const rootPreviewDbPath = (rootPath: string): string => join(rootPreviewCacheDir(rootPath), PREVIEW_CACHE_DB_DIR_NAME, PREVIEW_CACHE_DB_FILE_NAME)
  const fallbackPreviewCacheDir = (rootPath: string): string => join(fallbackCacheRootDir(rootPath), ROOT_PREVIEW_CACHE_DIR_NAME)
  const fallbackPreviewImageDir = (rootPath: string): string => join(fallbackPreviewCacheDir(rootPath), PREVIEW_CACHE_IMAGES_DIR_NAME)
  const fallbackPreviewDbPath = (rootPath: string): string => join(fallbackPreviewCacheDir(rootPath), PREVIEW_CACHE_DB_DIR_NAME, PREVIEW_CACHE_DB_FILE_NAME)
  const localPreviewImageDir = (): string => deps.dataPath(LOCAL_PREVIEW_CACHE_DIR_NAME)
  const cacheKeyForRootFile = (rootPath: string, filePath: string): string => {
    const relativePath = relativePathForRoot(rootPath, filePath)
    return relativePath || cacheKeyForPath(filePath)
  }
  const sharedFontId = (cacheIdentity: string, size: number, mtimeMs: number): string => deps.sha1(fileCacheSignature(cacheIdentity, size, mtimeMs))
  const isIgnoredWatcherPath = (fileName?: string): boolean => isIgnoredWatcherPathWithExtensions(fileName, deps.fontExtensions)

  return {
    legacyScanCachePath,
    fallbackCacheRootDir,
    fallbackScanCachePath,
    fallbackLegacyScanCachePath,
    rootCacheDir,
    rootScanCachePath,
    rootLegacyScanCachePath,
    rootIndexDbDir,
    rootIndexDbPath,
    rootEventsDbPath,
    rootHashDbPath,
    rootMetricsDbPath,
    rootCacheLockDir,
    rootIndexLockPath,
    fallbackIndexDbDir,
    fallbackIndexDbPath,
    rootPreviewCacheDir,
    legacyRootPreviewCacheDir,
    rootPreviewImageDir,
    rootPreviewDbPath,
    fallbackPreviewCacheDir,
    fallbackPreviewImageDir,
    fallbackPreviewDbPath,
    localPreviewImageDir,
    cacheKeyForRootFile,
    sharedFontId,
    isIgnoredWatcherPath
  }
}

export function isRootIndexDbPath(filePath: string): boolean {
  return extname(filePath).toLowerCase() === '.sqlite'
}

export function sqliteSidecarPaths(filePath: string): string[] {
  return [filePath, `${filePath}-wal`, `${filePath}-shm`, `${filePath}-journal`]
}

export function cacheKeyForPath(filePath: string): string {
  return filePath.toLowerCase()
}

export function fileCacheSignature(cacheIdentity: string, size: number, mtimeMs: number): string {
  return `${cacheIdentity.toLowerCase()}|${size}|${Math.round(mtimeMs)}`
}

export function isIgnoredInternalDirectoryName(name: string): boolean {
  const lowerName = name.toLowerCase()
  return lowerName === ROOT_CACHE_DIR_NAME.toLowerCase() || lowerName === ROOT_PREVIEW_CACHE_DIR_NAME.toLowerCase() || lowerName === '.hfm' || lowerName === '.hanfontmanager' || lowerName === '.hfm-locks'
}

export function isIgnoredWatcherPathWithExtensions(fileName: string | undefined, fontExtensions: Set<string>): boolean {
  if (!fileName) return false

  const parts = fileName.split(/[\\/]+/).filter(Boolean)
  if (parts.some((part) => isIgnoredInternalDirectoryName(part))) return true

  const leaf = (parts[parts.length - 1] || '').toLowerCase()
  if (!leaf) return false
  if ([ROOT_SCAN_CACHE_FILE_NAME, LEGACY_ROOT_SCAN_CACHE_FILE_NAME, ROOT_INDEX_DB_FILE_NAME, ROOT_SCAN_CACHE_LOCK_FILE_NAME, LEGACY_ROOT_SCAN_CACHE_LOCK_FILE_NAME, ROOT_CACHE_MANIFEST_FILE_NAME].includes(leaf)) return true
  if (leaf.endsWith('.tmp') || leaf.endsWith('.sqlite') || leaf.endsWith('.sqlite-wal') || leaf.endsWith('.sqlite-shm') || leaf.endsWith('.sqlite-journal')) return true

  const leafExt = extname(leaf)
  if (leafExt && !fontExtensions.has(leafExt)) return true

  return false
}
