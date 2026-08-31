import type { FontFormat, FontItem, FontScript } from './fontTypes'

export interface FontSearchResult {
  keyword: string
  ids: string[]
  total: number
  truncated: boolean
  engine: 'fts5' | 'like' | 'mixed' | 'none'
  elapsedMs: number
}

export type FontFilterKind = 'all' | 'favorites' | 'installed' | 'notInstalled' | 'active' | 'systemBuiltin' | 'cleanSystem' | 'format' | 'script' | 'collection' | 'tag' | 'sharedTag'
export type FontSidebarPage = 'library' | 'filters' | 'tags' | 'sharedTags' | 'folders'
export type FontTimeSortMode = 'created' | 'modified' | 'custom'
export type FontSortMode = 'smart' | 'nameAsc' | 'nameDesc' | 'createdDesc' | 'createdAsc' | 'modifiedDesc' | 'modifiedAsc' | 'sizeDesc' | 'sizeAsc'
export type FontInstallStatusFilter = 'all' | 'installed' | 'notInstalled'
export type FontCategoryFilter = 'all' | 'serif' | 'slabSerif' | 'sansSerif' | 'script' | 'monospace' | 'handwriting' | 'hei' | 'art'

export interface FontActiveFilterQuery {
  kind: FontFilterKind
  id?: string
  name?: string
}

export interface FontQueryRequest {
  keyword?: string
  limit?: number
  offset?: number
  sidebarPage?: FontSidebarPage
  activeFilter?: FontActiveFilterQuery
  selectedWatchedFolders?: string[]
  selectedFormats?: FontFormat[]
  selectedScripts?: FontScript[]
  selectedCategory?: FontCategoryFilter
  selectedCollectionId?: string
  selectedTagName?: string
  selectedFolderId?: string
  installStatus?: FontInstallStatusFilter
  timeSortMode?: FontTimeSortMode
  sortMode?: FontSortMode
}

export interface FontQueryResult {
  queryKey: string
  ids: string[]
  total: number
  truncated: boolean
  engine: 'sql' | 'like' | 'mixed' | 'none'
  elapsedMs: number
}


export interface FontTagRevisionMetadata {
  source?: string
  requested?: unknown
  mergedIndex?: Record<string, unknown>
  localTagsSignature?: string
  sharedMetadataSignatures?: Record<string, string>
}

export interface FontQueryPageResult {
  queryKey: string
  items: FontItem[]
  total: number
  offset: number
  limit: number
  truncated: boolean
  engine: 'sql' | 'like' | 'mixed' | 'none'
  elapsedMs: number
  tagRevision?: FontTagRevisionMetadata
}

export interface FontMetricsResult {
  total: number
  favoriteCount: number
  installedCount: number
  notInstalledCount: number
  installStatusKnownCount?: number
  installStatusMissingCount?: number
  installStatusReady?: boolean
  activeCount: number
  systemDefaultCount: number
  formatCounts: Record<FontFormat, number>
  categoryCounts: Record<FontCategoryFilter, number>
  scriptCounts: Partial<Record<FontScript, number>>
  collectionCounts: Record<string, number>
  tagCounts: Record<string, number>
  localTagCounts?: Record<string, number>
  sharedTagCounts?: Record<string, number>
  folderCounts: Record<string, number>
  elapsedMs: number
  tagRevision?: FontTagRevisionMetadata
}
