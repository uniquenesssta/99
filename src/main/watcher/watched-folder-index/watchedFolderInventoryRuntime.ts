import { extname, isAbsolute, relative, resolve } from 'node:path'
import { isIgnoredInternalDirectoryName } from '../../cache/cachePaths'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import type { FontIndexFileInput } from '../manual-refresh/fontIndexEntryBatchRuntime'

export interface WatcherMetadataInventory {
  rootPath: string
  files: ReadonlyMap<string, { size: number; mtimeMs: number }>
  complete: true
}

export interface WatchedFolderApplyContext {
  inventory?: WatcherMetadataInventory
  signal?: AbortSignal
  assertCurrent?: () => void
  onProgress?: (pendingCount: number) => void
  /** Bounded concrete change hints; never a root-wide content reparse. */
  forceVerifyPaths?: ReadonlySet<string>
}

/** Only a complete, exact-root metadata receipt can authorize missing-row reconciliation. */
export function validatedWatcherInventoryRows(rootPath: string, inventory: WatcherMetadataInventory, extensions: Set<string>): FontIndexFileInput[] {
  if (inventory.complete !== true || normalizePathForCacheCompare(resolve(inventory.rootPath)) !== normalizePathForCacheCompare(resolve(rootPath))) throw new Error('监听目录快照不完整或根目录不匹配。')
  const keys = new Set<string>()
  const rows: FontIndexFileInput[] = []
  for (const [name, stat] of inventory.files) {
    const normalized = name.replaceAll('\\', '/')
    const segments = normalized.split('/')
    if (!name || isAbsolute(name) || /[:\0]/.test(name) || segments.some(part => !part || part === '.' || part === '..')) throw new Error('监听目录快照包含非法相对路径。')
    const key = normalized.toLowerCase()
    if (keys.has(key)) throw new Error('监听目录快照包含重复文件身份。')
    keys.add(key)
    if (!Number.isSafeInteger(stat?.size) || stat.size < 0 || !Number.isFinite(stat?.mtimeMs)) throw new Error('监听目录快照包含无效文件属性。')
    const file = resolve(rootPath, normalized)
    const rel = relative(rootPath, file)
    if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error('监听目录快照超出根目录。')
    if (segments.slice(0, -1).some(part => part === 'node_modules' || part.startsWith('.') || isIgnoredInternalDirectoryName(part)) || segments.at(-1)!.startsWith('._') || !extensions.has(extname(file).toLowerCase())) continue
    rows.push({ file, freshStat: { size: stat.size, mtimeMs: stat.mtimeMs } })
  }
  return rows
}
