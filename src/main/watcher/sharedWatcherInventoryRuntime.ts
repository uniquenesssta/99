import type { WatcherMetadataInventory } from './watched-folder-index/watchedFolderInventoryRuntime'

/** Decode a complete metadata-only native receipt. Any malformed row rejects the whole snapshot. */
export function sharedWatcherInventory(rootPath: string, value: unknown): WatcherMetadataInventory {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-shared-watcher-snapshot')
  const rows = Object.entries(value)
  if (rows.length > 200000) throw new Error('shared-watcher-snapshot-budget')
  const files = new Map<string, { size: number; mtimeMs: number }>()
  const names = new Set<string>()
  for (const [rawPath, raw] of rows) {
    const path = rawPath.replaceAll('\\', '/')
    const parts = path.split('/')
    const key = path.toLowerCase()
    if (!path || path.includes('\0') || path.includes(':') || parts.some(part => !part || part === '.' || part === '..') || names.has(key)) throw new Error('invalid-shared-watcher-path')
    names.add(key)
    if (!Array.isArray(raw) || raw.length !== 2 || !Number.isSafeInteger(raw[0]) || raw[0] < 0 || typeof raw[1] !== 'string' || !/^-?\d{1,30}$/.test(raw[1])) throw new Error('invalid-shared-watcher-stat')
    const nanos = BigInt(raw[1])
    const mtimeMs = Number(nanos / 1000000n) + Number(nanos % 1000000n) / 1000000
    if (!Number.isFinite(mtimeMs) || Math.abs(mtimeMs) > Number.MAX_SAFE_INTEGER) throw new Error('invalid-shared-watcher-time')
    files.set(path, { size: raw[0], mtimeMs })
  }
  return { rootPath, complete: true, files }
}
