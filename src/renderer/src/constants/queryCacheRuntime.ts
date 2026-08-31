import type { FontQueryRequest } from '@shared/types'

export function sanitizeQueryStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean)))
    : []
}

export function rendererFontQueryCacheKey(request: FontQueryRequest): string {
  // Keep this byte-for-byte compatible with main/index.ts fontQueryCacheKey().
  // If the renderer key differs from the backend key, databasePageReady becomes false
  // and the UI silently falls back to the partial in-memory hot state. That is the
  // main reason a complete database can appear as an incomplete library/folder view.
  const defaultLimit = 60
  return JSON.stringify({
    keyword: String(request.keyword || '').trim(),
    sidebarPage: request.sidebarPage || 'library',
    activeFilter: request.activeFilter || { kind: 'all', name: '全部字体' },
    selectedWatchedFolders: sanitizeQueryStringArray(request.selectedWatchedFolders).sort(),
    selectedFormats: sanitizeQueryStringArray(request.selectedFormats).sort(),
    selectedScripts: sanitizeQueryStringArray(request.selectedScripts).sort(),
    selectedCategory: request.selectedCategory || 'all',
    selectedCollectionId: String(request.selectedCollectionId || ''),
    selectedTagName: String(request.selectedTagName || ''),
    selectedFolderId: String(request.selectedFolderId || ''),
    installStatus: request.installStatus || 'all',
    timeSortMode: request.timeSortMode || 'created',
    sortMode: request.sortMode || 'smart',
    offset: Math.max(0, Number(request.offset || 0) || 0),
    limit: Math.max(1, Math.min(500000, Number(request.limit || defaultLimit) || defaultLimit))
  })
}

