import type { FontFormat,FontItem,FontQueryPageResult,FontQueryRequest,FontScript,LibraryState } from '@shared/types'
import { VIRTUAL_OVERSCAN_ROWS,VIRTUAL_PANEL_PADDING,getVirtualGridColumns } from './appConstants'
import type { ActiveFilter,FontCategory,FontComputedIndex,InstallStatusFilter,SidebarPage,SortMode,TimeSortMode,VirtualLayout,VirtualViewport } from './appTypes'
import { filterMatchesFontIndex,inTimeSortRangeIndex } from './fontFilteringMetrics'
import { compareFontsForSort,compareFontsForTimeSort } from './fontSort'
import { fontBelongsToAnyFolder,fontBelongsToFolder,fontInsideRootFolder } from './libraryNormalize'
import { filterFontByLibraryTagAuthority } from './fontTagStateAuthorityRuntime'

export interface RendererFontQueryRequestOptions {
  deferredSearch: string
  databasePageLimit: number
  databasePageOffset: number
  sidebarPage: SidebarPage
  activeFilter: ActiveFilter
  selectedWatchedFolders: string[]
  selectedFormats: FontFormat[]
  selectedScripts: FontScript[]
  selectedCategory: FontCategory
  selectedTagName: string
  selectedSharedTagName: string
  selectedFolderId: string
  installStatus: InstallStatusFilter
  timeSortMode: TimeSortMode
  sortMode: SortMode
}

export function createRendererFontQueryRequest(options: RendererFontQueryRequestOptions): FontQueryRequest {
  const querySidebarPage = options.sidebarPage === 'developer' ? 'library' : options.sidebarPage

  return {
    keyword: options.deferredSearch.trim(),
    limit: options.databasePageLimit,
    offset: options.databasePageOffset,
    sidebarPage: querySidebarPage,
    activeFilter: querySidebarPage === 'library' ? options.activeFilter : { kind: 'all' },
    selectedWatchedFolders: querySidebarPage === 'filters' ? options.selectedWatchedFolders : [],
    selectedFormats: querySidebarPage === 'filters' ? options.selectedFormats : [],
    selectedScripts: querySidebarPage === 'filters' ? options.selectedScripts : [],
    selectedCategory: querySidebarPage === 'filters' ? options.selectedCategory : 'all',
    selectedCollectionId: '',
    selectedTagName: querySidebarPage === 'sharedTags' ? options.selectedSharedTagName : querySidebarPage === 'tags' ? options.selectedTagName : '',
    selectedFolderId: querySidebarPage === 'folders' ? options.selectedFolderId : '',
    installStatus: options.installStatus,
    timeSortMode: options.timeSortMode,
    sortMode: options.sortMode
  }
}

export interface VisibleFontsOptions {
  databasePageReady: boolean
  databasePageResult: FontQueryPageResult | null
  allFonts: FontItem[]
  fontIndexById: Map<string, FontComputedIndex>
  deferredSearch: string
  activeFilter: ActiveFilter
  selectedWatchedFolders: string[]
  selectedFormats: FontFormat[]
  selectedScripts: FontScript[]
  selectedCategory: FontCategory
  selectedTagName: string
  selectedSharedTagName: string
  selectedFolderId: string
  installStatus: InstallStatusFilter
  timeSortMode: TimeSortMode
  sortMode: SortMode
  sidebarPage: SidebarPage
  library: LibraryState
}

function optimisticTagPageMatches(font: FontItem, options: VisibleFontsOptions): boolean {
  if (options.sidebarPage === 'tags') {
    if (options.selectedTagName) return !!font.localTagNames?.includes(options.selectedTagName)
    return !!font.localTagNames?.length
  }
  if (options.sidebarPage === 'sharedTags') {
    if (options.selectedSharedTagName) return !!font.tagNames?.includes(options.selectedSharedTagName)
    return !!font.tagNames?.length
  }
  return true
}

function mergeOptimisticTagPageFonts(items: FontItem[], options: VisibleFontsOptions): FontItem[] {
  if (options.sidebarPage !== 'tags' && options.sidebarPage !== 'sharedTags') return items

  const seen = new Set(items.map((font) => font.id).filter(Boolean))
  const optimisticFonts = options.allFonts.filter((font) => {
    if (!font?.id || seen.has(font.id)) return false
    return optimisticTagPageMatches(font, options)
  })
  if (!optimisticFonts.length) return items.filter((font) => optimisticTagPageMatches(font, options))
  return [...optimisticFonts, ...items.filter((font) => optimisticTagPageMatches(font, options))]
}

export function buildVisibleFonts(options: VisibleFontsOptions): FontItem[] {
  if (options.databasePageReady && options.databasePageResult) {
    const items = options.databasePageResult.items.map((font) =>
      filterFontByLibraryTagAuthority(options.library, options.library.fonts[font.id] || font)
    )
    return mergeOptimisticTagPageFonts(items, options)
  }

  const keyword = options.deferredSearch.trim().toLowerCase()
  return options.allFonts
    .filter((font) => {
      const index = options.fontIndexById.get(font.id)
      if (!index || index.bad) return false
      if (!inTimeSortRangeIndex(index, options.timeSortMode)) return false
      if (options.sidebarPage !== 'library') {
        if (options.installStatus === 'installed' && !index.installed) return false
        if (options.installStatus === 'notInstalled' && index.installed) return false
      }

      if (options.sidebarPage === 'library' && !filterMatchesFontIndex(options.activeFilter, font, index)) return false
      if (options.sidebarPage === 'filters') {
        if (options.selectedWatchedFolders.length && !options.selectedWatchedFolders.some((folder) => fontInsideRootFolder(font, folder))) return false
        if (options.selectedFormats.length && !options.selectedFormats.includes(font.format || 'unknown')) return false
        if (options.selectedScripts.length && !options.selectedScripts.some((script) => index.scripts.includes(script))) return false
        if (options.selectedCategory !== 'all' && index.category !== options.selectedCategory) return false
      }
      if (options.sidebarPage === 'tags') {
        if (options.selectedTagName) {
          if (!font.localTagNames?.includes(options.selectedTagName)) return false
        } else if (!font.localTagNames?.length) {
          return false
        }
      }
      if (options.sidebarPage === 'sharedTags') {
        if (options.selectedSharedTagName) {
          if (!font.tagNames?.includes(options.selectedSharedTagName)) return false
        } else if (!font.tagNames?.length) {
          return false
        }
      }
      if (options.sidebarPage === 'folders') {
        if (options.selectedFolderId) {
          if (!fontBelongsToFolder(options.library, font, options.selectedFolderId)) return false
        } else if (!fontBelongsToAnyFolder(options.library, font)) {
          return false
        }
      }

      if (!keyword) return true
      return index.searchText.includes(keyword)
    })
    .sort((a, b) => {
      if (options.sortMode === 'smart') return compareFontsForTimeSort(a, b, options.timeSortMode)
      return compareFontsForSort(a, b, options.sortMode)
    })
}

export interface VirtualLayoutOptions {
  databasePageReady: boolean
  databasePageResult: FontQueryPageResult | null
  visibleFonts: FontItem[]
  virtualViewport: VirtualViewport
  minCardWidth: number
  rowHeight: number
}

export function buildVirtualLayout(options: VirtualLayoutOptions): VirtualLayout {
  const columns = getVirtualGridColumns(options.virtualViewport.width, options.minCardWidth)
  const incrementalDatabasePage = Boolean(options.databasePageReady && options.databasePageResult && options.databasePageResult.offset === 0)
  const totalCount = incrementalDatabasePage
    ? options.visibleFonts.length
    : options.databasePageReady
      ? (options.databasePageResult?.total || 0)
      : options.visibleFonts.length
  const totalRows = Math.ceil(totalCount / columns)

  if (options.databasePageReady && options.databasePageResult && !incrementalDatabasePage) {
    const pageRow = Math.floor(options.databasePageResult.offset / Math.max(1, columns))
    return {
      items: options.visibleFonts,
      top: VIRTUAL_PANEL_PADDING + pageRow * options.rowHeight,
      totalHeight: Math.max(280, VIRTUAL_PANEL_PADDING * 2 + totalRows * options.rowHeight),
      columns,
      startIndex: options.databasePageResult.offset,
      endIndex: options.databasePageResult.offset + options.visibleFonts.length
    }
  }

  const firstVisibleRow = Math.max(0, Math.floor(Math.max(0, options.virtualViewport.scrollTop - VIRTUAL_PANEL_PADDING) / options.rowHeight) - VIRTUAL_OVERSCAN_ROWS)
  const visibleRows = Math.ceil(Math.max(1, options.virtualViewport.height) / options.rowHeight) + VIRTUAL_OVERSCAN_ROWS * 2
  const maxStartIndex = Math.max(0, options.visibleFonts.length - visibleRows * columns)
  const startIndex = Math.min(maxStartIndex, Math.max(0, firstVisibleRow * columns))
  const endIndex = Math.min(options.visibleFonts.length, (Math.floor(startIndex / columns) + visibleRows) * columns)
  const topRow = Math.floor(startIndex / columns)

  return {
    items: options.visibleFonts.slice(startIndex, endIndex),
    top: VIRTUAL_PANEL_PADDING + topRow * options.rowHeight,
    totalHeight: Math.max(280, VIRTUAL_PANEL_PADDING * 2 + totalRows * options.rowHeight),
    columns,
    startIndex,
    endIndex
  }
}

export function buildTagSuggestions(tags: string[], currentTags: string[] | undefined, queryInput: string, limit = 8): string[] {
  const query = queryInput.trim().toLocaleLowerCase()
  if (!query) return []

  const current = new Set(currentTags || [])
  return tags
    .filter((tag) => !current.has(tag) && tag.toLocaleLowerCase().includes(query))
    .sort((a, b) => {
      const aLower = a.toLocaleLowerCase()
      const bLower = b.toLocaleLowerCase()
      const aStarts = aLower.startsWith(query) ? 0 : 1
      const bStarts = bLower.startsWith(query) ? 0 : 1
      return aStarts - bStarts || a.localeCompare(b, 'zh-Hans-CN')
    })
    .slice(0, limit)
}
