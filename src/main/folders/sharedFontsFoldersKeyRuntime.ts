import { resolve } from 'node:path'
import { normalizePathForCacheCompare } from '../path/cachePath'

export function sharedFontsFoldersKey(folders: string[]): string {
  return Array.from(
    new Set(
      (folders || [])
        .filter(Boolean)
        .map((item) => normalizePathForCacheCompare(resolve(item))),
    ),
  )
    .sort()
    .join('\u0000')
}
