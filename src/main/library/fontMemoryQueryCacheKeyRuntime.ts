import { resolve } from 'node:path'
import type { FontQueryRequest } from '../../shared/types'
import { sanitizeStringArray } from './fontQuerySqlRuntime'

export function sharedFontsFoldersKey(
  folders: string[],
  normalizePathForCacheCompare: (filePath: string) => string,
): string {
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

export function fontFilterCacheKey(
  folders: string[],
  request: FontQueryRequest,
  normalizePathForCacheCompare: (filePath: string) => string,
): string {
  return JSON.stringify({
    folders: sharedFontsFoldersKey(folders, normalizePathForCacheCompare),
    keyword: String(request.keyword || '').trim(),
    sidebarPage: request.sidebarPage || 'library',
    activeFilter: request.activeFilter || { kind: 'all', name: '全部字体' },
    selectedWatchedFolders: sanitizeStringArray(request.selectedWatchedFolders).sort(),
    selectedFormats: sanitizeStringArray(request.selectedFormats).sort(),
    selectedScripts: sanitizeStringArray(request.selectedScripts).sort(),
    selectedCategory: request.selectedCategory || 'all',
    selectedCollectionId: String(request.selectedCollectionId || ''),
    selectedTagName: String(request.selectedTagName || ''),
    selectedFolderId: String(request.selectedFolderId || ''),
    installStatus: request.installStatus || 'all',
    timeSortMode: request.timeSortMode || 'created',
    sortMode: request.sortMode || 'smart',
  })
}
