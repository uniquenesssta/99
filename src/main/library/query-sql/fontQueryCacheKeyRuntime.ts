import type { FontQueryRequest } from '@shared/types';
import { normalizeQueryLimit, sanitizeStringArray } from './fontQuerySqlTypes';

export function fontQueryCacheKey(request: FontQueryRequest): string {
  return JSON.stringify({
    keyword: String(request.keyword || "").trim(),
    sidebarPage: request.sidebarPage || "library",
    activeFilter: request.activeFilter || { kind: "all", name: "全部字体" },
    selectedWatchedFolders: sanitizeStringArray(
      request.selectedWatchedFolders,
    ).sort(),
    selectedFormats: sanitizeStringArray(request.selectedFormats).sort(),
    selectedScripts: sanitizeStringArray(request.selectedScripts).sort(),
    selectedCategory: request.selectedCategory || "all",
    selectedCollectionId: String(request.selectedCollectionId || ""),
    selectedTagName: String(request.selectedTagName || ""),
    selectedFolderId: String(request.selectedFolderId || ""),
    installStatus: request.installStatus || "all",
    timeSortMode: request.timeSortMode || "created",
    sortMode: request.sortMode || "smart",
    offset: Math.max(0, Number(request.offset || 0) || 0),
    limit: normalizeQueryLimit(request),
  });
}
