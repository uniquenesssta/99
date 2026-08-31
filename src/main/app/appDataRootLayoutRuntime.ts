import { join } from 'node:path'

export const CLEAN_APP_DATA_LAYOUT_VERSION = 3

export const chromiumUserDataEntryNames = new Set([
  'blob_storage',
  'Cache',
  'Code Cache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'DIPS',
  'GPUCache',
  'Local Storage',
  'Network',
  'Session Storage',
  'Shared Dictionary',
  'SharedStorage',
  'VideoDecodeStats',
  'WebStorage',
  'Local State',
  'Preferences',
  'lockfile'
])

const rootLevelDirectoryNames = new Set([
  'data',
  'db',
  'cache',
  'logs',
  'backups',
  'runtime',
  'electron'
])

const dbDirectoryNames = new Set([
  'db'
])

const logDirectoryNames = new Set([
  'logs'
])

const runtimeDirectoryNames = new Set([
  'runtime'
])

const backupDirectoryNames = new Set([
  'backups'
])

const cacheScanEntryNames = new Set([
  'font-scan-cache.json',
  'folder-scan-cache'
])

const cachePreviewEntryNames = new Set([
  'preview-cache',
  'preview-fallback.sqlite',
  'preview-fallback.sqlite-shm',
  'preview-fallback.sqlite-wal',
  'preview-fallback.sqlite-journal'
])

export function isChromiumUserDataEntry(entryName: string): boolean {
  return chromiumUserDataEntryNames.has(entryName)
}

export function isKnownRootLevelDirectory(entryName: string): boolean {
  return rootLevelDirectoryNames.has(entryName)
}

export function resolveCleanAppDataPath(baseRoot: string, ...segments: string[]): string {
  if (!segments.length) return baseRoot
  const [head, ...tail] = segments

  if (head === 'manifest.json') return join(baseRoot, 'manifest.json', ...tail)
  if (dbDirectoryNames.has(head)) return join(baseRoot, 'db', ...tail)
  if (logDirectoryNames.has(head)) return join(baseRoot, 'logs', ...tail)
  if (runtimeDirectoryNames.has(head)) return join(baseRoot, 'runtime', ...tail)
  if (backupDirectoryNames.has(head)) return join(baseRoot, 'backups', ...tail)
  if (cacheScanEntryNames.has(head)) return join(baseRoot, 'cache', 'scan', head, ...tail)
  if (head === 'preview-cache') return join(baseRoot, 'cache', 'preview', 'images', ...tail)
  if (cachePreviewEntryNames.has(head)) return join(baseRoot, 'cache', 'preview', head, ...tail)
  if (head === 'cache') return join(baseRoot, 'cache', ...tail)
  if (head === 'electron') return join(baseRoot, 'electron', ...tail)
  if (head === 'data') return join(baseRoot, 'data', ...tail)

  return join(baseRoot, 'data', ...segments)
}

export function cleanAppDataRequiredDirectories(baseRoot: string): string[] {
  return [
    baseRoot,
    join(baseRoot, 'data'),
    join(baseRoot, 'data', 'license'),
    join(baseRoot, 'data', 'machines'),
    join(baseRoot, 'db'),
    join(baseRoot, 'db', 'corrupt'),
    join(baseRoot, 'cache'),
    join(baseRoot, 'cache', 'scan'),
    join(baseRoot, 'cache', 'preview'),
    join(baseRoot, 'cache', 'preview', 'images'),
    join(baseRoot, 'logs'),
    join(baseRoot, 'runtime'),
    join(baseRoot, 'backups')
  ]
}
