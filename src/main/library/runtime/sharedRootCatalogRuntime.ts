import { normalizePathForCacheCompare } from '../../path/cachePath'

export const SHARED_ROOT_CATALOG_KEY = 'sharedRootCatalog'
export type ConfirmedRootCatalog = {
  rootId: string
  tags: string[]
  signature: string
  confirmedAt: number
}
export type SharedRootCatalog = {
  version: 1
  roots: ConfirmedRootCatalog[]
  unattributedTags: string[]
  publishedTags: string[]
}

export function sharedCatalogRootId(rootPath: string): string {
  return normalizePathForCacheCompare(rootPath)
}

function stringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

// Borrow the existing library handle. Neither a second database nor a write queue.
export function readSharedRootCatalog(db: any, currentTags: string[]): SharedRootCatalog {
  const fallback: SharedRootCatalog = { version: 1, roots: [], unattributedTags: [...currentTags], publishedTags: [...currentTags] }
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(SHARED_ROOT_CATALOG_KEY)
  try {
    const value = JSON.parse(row?.value || 'null')
    if (value?.version !== 1 || !Array.isArray(value.roots) || !stringList(value.unattributedTags) || !stringList(value.publishedTags)) return fallback
    if (JSON.stringify(value.publishedTags) !== JSON.stringify(currentTags)) return fallback
    const ids = new Set<string>()
    for (const root of value.roots) {
      if (!root || typeof root.rootId !== 'string' || !root.rootId || ids.has(root.rootId) || !stringList(root.tags) || typeof root.signature !== 'string' || !Number.isFinite(root.confirmedAt)) return fallback
      ids.add(root.rootId)
    }
    return value as SharedRootCatalog
  } catch { return fallback }
}

export function mergeSharedRootCatalog(
  previous: SharedRootCatalog,
  configuredRoots: string[],
  confirmed: ConfirmedRootCatalog[],
  complete: boolean,
  extraTags: string[],
  aggregateTags?: string[],
): SharedRootCatalog {
  const configured = new Set(configuredRoots.map(sharedCatalogRootId))
  const roots = new Map(previous.roots.filter(root => configured.has(root.rootId)).map(root => [root.rootId, root]))
  for (const root of confirmed) if (configured.has(root.rootId)) roots.set(root.rootId, root)
  // Old worker aggregate results have no root provenance. Keep them unattributed.
  const missingOwnership = [...configured].some(rootId => !roots.has(rootId))
  const unattributedTags = Array.from(new Set([
    ...(!complete && missingOwnership ? previous.publishedTags : []),
    ...(complete ? [] : previous.unattributedTags), ...extraTags, ...(aggregateTags || []),
  ]))
  const publishedTags = Array.from(new Set([...Array.from(roots.values()).flatMap(root => root.tags), ...unattributedTags]))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  return { version: 1, roots: Array.from(roots.values()), unattributedTags, publishedTags }
}
