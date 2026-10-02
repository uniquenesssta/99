import { isInstalled } from './fontDisplay'
import { hasFontUserIntent, mergeFontUserIntent } from './fontUserIntentRuntime'
import type { FontFormat,FontItem,FontQueryPageResult,FontQueryRequest,FontScript,LibraryState } from '@shared/types'
import { VIRTUAL_OVERSCAN_ROWS,VIRTUAL_PANEL_PADDING,getVirtualGridColumns } from './appConstants'
import type { ActiveFilter,FontCategory,FontComputedIndex,InstallStatusFilter,SidebarPage,SortMode,TimeSortMode,VirtualLayout,VirtualViewport } from './appTypes'
import { buildFontComputedIndex,filterMatchesFontIndex,inTimeSortRangeIndex } from './fontFilteringMetrics'
import { compareFontsForSort,compareFontsForTimeSort } from './fontSort'
import { fontBelongsToAnyFolder,fontBelongsToFolder,fontInsideRootFolder,normalizeFontPathForCompare } from './libraryNormalize'
import { filterFontByLibraryTagAuthority, isFontTagStateDirty } from './fontTagStateAuthorityRuntime'

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

function matchesInstallStatus(font: FontItem, status: InstallStatusFilter): boolean {
  if (status === 'installed') return isInstalled(font)
  if (status === 'notInstalled') return font.installStatusKnown === true && !isInstalled(font)
  return true
}

// Raw database offsets always remain untouched. Only a complete result can
// accept unseen optimistic members without guessing their pagination position.
export function visibleFontResultTotal(result: FontQueryPageResult | null, fonts: FontItem[]): number {
  return result ? Math.max(0, result.total + fonts.length - result.items.length) : fonts.length
}

function pendingFont(font: FontItem): boolean {
  return hasFontUserIntent(font) || isFontTagStateDirty(font, 'local') || isFontTagStateDirty(font, 'shared')
}

export function buildVisibleFonts(options: VisibleFontsOptions): FontItem[] {
  if (options.databasePageReady && options.databasePageResult) {
    const page = options.databasePageResult
    const items = page.items.map((font) => {
      const cached = options.library.fonts[font.id]
      const sameFile = cached && normalizeFontPathForCompare(cached.path) === normalizeFontPathForCompare(font.path)
      const current = sameFile ? mergeFontUserIntent(cached, {
        ...font,
        deleteProtected: cached.deleteProtected,
        ...(isFontTagStateDirty(cached, 'local') ? { localTagNames: cached.localTagNames } : {}),
        ...(isFontTagStateDirty(cached, 'shared') ? { tagNames: cached.tagNames } : {})
      }) : font
      return filterFontByLibraryTagAuthority(options.library, current)
    })
    const complete = page.offset === 0 && page.items.length >= page.total
    const seen = new Set(items.map((font) => font.id))
    const pending = complete ? options.allFonts.filter((font) => !seen.has(font.id) && pendingFont(font)) : []
    const candidates = [...items, ...pending]
    const fontIndexById = new Map(candidates.map((font) => [font.id, buildFontComputedIndex(font)]))
    const filtered = buildVisibleFonts({ ...options, databasePageReady: false, allFonts: candidates, fontIndexById })
    if (complete && candidates.some(pendingFont)) return filtered
    // Preserve the server's order for a partial page; pending sort changes are
    // resolved by the mutation-triggered query, never by reordering one window.
    const accepted = new Set(filtered.map(font => font.id))
    return items.filter(font => accepted.has(font.id))
  }

  const keyword = options.deferredSearch.trim().toLowerCase()
  return options.allFonts
    .filter((font) => {
      const index = options.fontIndexById.get(font.id)
      if (!index || index.bad) return false
      if (!inTimeSortRangeIndex(index, options.timeSortMode)) return false
      if (!matchesInstallStatus(font, options.installStatus)) return false

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
  columns?: number
  rowGap?: number
  panelPadding?: number
}

export function buildVirtualLayout(options: VirtualLayoutOptions): VirtualLayout {
  const columns = options.columns ?? getVirtualGridColumns(options.virtualViewport.width, options.minCardWidth)
  const panelPadding = options.panelPadding ?? VIRTUAL_PANEL_PADDING
  const rowGap = options.rowGap ?? 0
  const incrementalDatabasePage = Boolean(options.databasePageReady && options.databasePageResult && options.databasePageResult.offset === 0)
  // The scrollbar represents the query, not the number of pages fetched so far.
  // Replacing/refilling a page must never shorten the browser's scroll range.
  const totalCount = options.databasePageReady
    ? visibleFontResultTotal(options.databasePageResult, options.visibleFonts)
    : options.visibleFonts.length
  const totalRows = Math.ceil(totalCount / columns)

  if (options.databasePageReady && options.databasePageResult && !incrementalDatabasePage) {
    const offset = options.databasePageResult.offset
    const visibleRows = Math.ceil(Math.max(1, options.virtualViewport.height) / options.rowHeight) + VIRTUAL_OVERSCAN_ROWS * 2
    const firstRow = Math.max(0, Math.floor(Math.max(0, options.virtualViewport.scrollTop - panelPadding) / options.rowHeight) - VIRTUAL_OVERSCAN_ROWS)
    const lastStartRow = Math.max(0, Math.ceil((offset + options.visibleFonts.length) / columns) - visibleRows)
    const startIndex = Math.max(offset, Math.min(firstRow, lastStartRow) * columns)
    const endIndex = Math.min(offset + options.visibleFonts.length, (Math.floor(startIndex / columns) + visibleRows) * columns)
    return {
      items: options.visibleFonts.slice(startIndex - offset, endIndex - offset),
      top: panelPadding + Math.floor(startIndex / columns) * options.rowHeight,
      totalHeight: Math.max(280, panelPadding * 2 + Math.max(0, totalRows * options.rowHeight - rowGap)),
      columns,
      startIndex,
      endIndex
    }
  }

  const firstVisibleRow = Math.max(0, Math.floor(Math.max(0, options.virtualViewport.scrollTop - panelPadding) / options.rowHeight) - VIRTUAL_OVERSCAN_ROWS)
  const visibleRows = Math.ceil(Math.max(1, options.virtualViewport.height) / options.rowHeight) + VIRTUAL_OVERSCAN_ROWS * 2
  const maxStartIndex = Math.max(0, Math.ceil(options.visibleFonts.length / columns) - visibleRows) * columns
  const startIndex = Math.min(maxStartIndex, Math.max(0, firstVisibleRow * columns))
  const endIndex = Math.min(options.visibleFonts.length, (Math.floor(startIndex / columns) + visibleRows) * columns)
  const topRow = Math.floor(startIndex / columns)

  return {
    items: options.visibleFonts.slice(startIndex, endIndex),
    top: panelPadding + topRow * options.rowHeight,
    totalHeight: Math.max(280, panelPadding * 2 + Math.max(0, totalRows * options.rowHeight - rowGap)),
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
