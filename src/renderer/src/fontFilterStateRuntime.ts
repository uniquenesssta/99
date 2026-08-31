import type { FolderNode,FontFormat,FontScript } from '@shared/types'
import type { FilterGroupId,FontCategory } from './appTypes'

export interface AdvancedFilterState {
  watchedFolders: string[]
  formats: FontFormat[]
  scripts: FontScript[]
  category: FontCategory
}

export function createClearedAdvancedFilterState(): AdvancedFilterState {
  return {
    watchedFolders: [],
    formats: [],
    scripts: [],
    category: 'all'
  }
}

export function nextExpandedFilterGroups(
  prev: Partial<Record<FilterGroupId, true>>,
  groupId: FilterGroupId,
  expanded: boolean
): Partial<Record<FilterGroupId, true>> {
  const next = { ...prev }
  if (expanded) next[groupId] = true
  else delete next[groupId]
  return next
}

export function pruneExpandedFolderIds(
  prev: Record<string, true>,
  folders: string[] = [],
  folderNodes: FolderNode[] = []
): Record<string, true> {
  const validFolderIds = new Set([...folders, ...folderNodes.map((node) => node.id)])
  const next = Object.fromEntries(Object.entries(prev).filter(([id]) => validFolderIds.has(id))) as Record<string, true>
  return Object.keys(next).length === Object.keys(prev).length ? prev : next
}

export function pruneSelectedWatchedFolders(prev: string[], folders: string[] = []): string[] {
  const next = prev.filter((folder) => folders.includes(folder))
  if (next.length === prev.length && next.every((folder, index) => folder === prev[index])) return prev
  return next
}

export function toggleExpandedFolderId(prev: Record<string, true>, folderId: string): Record<string, true> {
  if (prev[folderId]) {
    const next = { ...prev }
    delete next[folderId]
    return next
  }

  return { ...prev, [folderId]: true }
}
