import { isInstalled } from './fontDisplay'
import { badFontRecordReason } from './library-normalize/libraryNormalizeBase'
import { createFontViewMembershipDiagnostics, recordFontViewRejection, type FontViewMembershipDiagnostics, type FontViewRejectionReason } from './fontViewDiagnostics'
import { hasFontUserIntent, mergeFontUserIntent } from './fontUserIntentRuntime'
import type { FontFormat,FontItem,FontQueryPageResult,FontQueryRequest,FontScript,LibraryState } from '@shared/types'
import { VIRTUAL_OVERSCAN_ROWS,VIRTUAL_PANEL_PADDING,getVirtualGridColumns } from './appConstants'
import type { ActiveFilter,FontCategory,FontComputedIndex,InstallStatusFilter,SidebarPage,SortMode,TimeSortMode,VirtualLayout,VirtualViewport } from './appTypes'
import { buildFontComputedIndex,filterMatchesFontIndex,inTimeSortRangeIndex } from './fontFilteringMetrics'
import { compareFontsForSort,compareFontsForTimeSort } from './fontSort'
import { fontBelongsToAnyFolder,fontBelongsToFolder,fontInsideRootFolder,normalizeFontPathForCompare } from './libraryNormalize'
import { applyFontTagEdit, filterFontByLibraryTagAuthority, isFontTagStateDirty } from './fontTagStateAuthorityRuntime'

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

function isCompleteFontPage(result: FontQueryPageResult): boolean {
  return result.offset === 0 && result.items.length >= result.total
}

// A partial page cannot establish the globally filtered population. Its query
// total and raw offsets remain authoritative; exclusions are reported separately.
// Only a complete result may count local filtering and unseen pending members.
export function visibleFontResultTotal(result: FontQueryPageResult | null, fonts: FontItem[]): number {
  return result && !isCompleteFontPage(result) ? Math.max(0, result.total) : fonts.length
}

function pendingFont(font: FontItem): boolean {
  return hasFontUserIntent(font) || isFontTagStateDirty(font, 'local') || isFontTagStateDirty(font, 'shared')
}

function fontRejectionReason(options: VisibleFontsOptions, font: FontItem, index: FontComputedIndex | undefined): FontViewRejectionReason | null {
  if (!index) return 'missing-index'
  if (index.bad) return badFontRecordReason(font) || 'invalid-record'
  if (!inTimeSortRangeIndex(index, options.timeSortMode)) return 'time-range'
  if (!matchesInstallStatus(font, options.installStatus)) return font.installStatusKnown !== true && !isInstalled(font) ? 'install-status-unknown' : 'install-status-mismatch'

  if (options.sidebarPage === 'library' && !filterMatchesFontIndex(options.activeFilter, font, index)) return 'active-filter'
  if (options.sidebarPage === 'filters') {
    if (options.selectedWatchedFolders.length && !options.selectedWatchedFolders.some((folder) => fontInsideRootFolder(font, folder))) return 'watched-folder'
    if (options.selectedFormats.length && !options.selectedFormats.includes(font.format || 'unknown')) return 'format'
    if (options.selectedScripts.length && !options.selectedScripts.some((script) => index.scripts.includes(script))) return 'script'
    if (options.selectedCategory !== 'all' && index.category !== options.selectedCategory) return 'category'
  }
  if (options.sidebarPage === 'tags') {
    if (options.selectedTagName ? !font.localTagNames?.includes(options.selectedTagName) : !font.localTagNames?.length) return 'local-tag'
  }
  if (options.sidebarPage === 'sharedTags') {
    if (options.selectedSharedTagName ? !font.tagNames?.includes(options.selectedSharedTagName) : !font.tagNames?.length) return 'shared-tag'
  }
  if (options.sidebarPage === 'folders') {
    if (options.selectedFolderId ? !fontBelongsToFolder(options.library, font, options.selectedFolderId) : !fontBelongsToAnyFolder(options.library, font)) return 'folder'
  }
  const keyword = options.deferredSearch.trim().toLowerCase()
  return keyword && !index.searchText.includes(keyword) ? 'search' : null
}

function sortVisibleFonts(options: VisibleFontsOptions, fonts: FontItem[]): FontItem[] {
  return fonts.sort((a, b) => options.sortMode === 'smart'
    ? compareFontsForTimeSort(a, b, options.timeSortMode)
    : compareFontsForSort(a, b, options.sortMode))
}

export interface VisibleFontResult {
  fonts: FontItem[]
  diagnostics: FontViewMembershipDiagnostics
}

export function buildVisibleFontResult(options: VisibleFontsOptions): VisibleFontResult {
  if (options.databasePageReady && options.databasePageResult) {
    const page = options.databasePageResult
    const complete = isCompleteFontPage(page)
    const seen = new Set(page.items.map((font) => font.id))
    const diagnostics = createFontViewMembershipDiagnostics(true, complete, page.items.length - seen.size)
    const pending = complete ? options.allFonts.filter((font) => !seen.has(font.id) && pendingFont(font)) : []
    const fonts: FontItem[] = []
    let hasPending = pending.length > 0
    for (const [ordinal, raw] of page.items.entries()) {
      const cached = options.library.fonts[raw.id]
      const sameFile = cached && normalizeFontPathForCompare(cached.path) === normalizeFontPathForCompare(raw.path)
      let current = sameFile ? mergeFontUserIntent(cached, {
        ...raw,
        deleteProtected: cached.deleteProtected
      }) : raw
      if (sameFile) for (const scope of ['local', 'shared'] as const) {
        // Copy the edit identity with its value. Catalog reconciliation must not
        // mistake a still-pending edit for a settled database tag array.
        if (isFontTagStateDirty(cached, scope)) current = applyFontTagEdit(current, cached, scope)
      }
      const font = filterFontByLibraryTagAuthority(options.library, current)
      hasPending ||= pendingFont(font)
      // Decide for this row, never for another row sharing its ID. An accepted
      // sibling must not reintroduce a rejected row via an accepted-ID set.
      const reason = fontRejectionReason(options, font, buildFontComputedIndex(font))
      if (!reason) { fonts.push(font); continue }
      const rawReason = fontRejectionReason(options, raw, buildFontComputedIndex(raw))
      const intentReason = current === raw ? rawReason : fontRejectionReason(options, current, buildFontComputedIndex(current))
      recordFontViewRejection(diagnostics, raw, page.offset + ordinal,
        rawReason ? 'database-row' : intentReason ? 'user-intent' : 'tag-authority', rawReason, intentReason, reason)
    }
    for (const [ordinal, font] of pending.entries()) {
      const reason = fontRejectionReason(options, font, buildFontComputedIndex(font))
      if (reason) recordFontViewRejection(diagnostics, font, ordinal, 'pending-row', reason, reason, reason)
      else fonts.push(font)
    }
    // Preserve server ordering on partial pages. Only a complete population can
    // be sorted after optimistic edits without inventing pagination positions.
    return { fonts: complete && hasPending ? sortVisibleFonts(options, fonts) : fonts, diagnostics }
  }

  const diagnostics = createFontViewMembershipDiagnostics(false, true)
  const fonts = options.allFonts.filter((font, ordinal) => {
    const reason = fontRejectionReason(options, font, options.fontIndexById.get(font.id))
    if (!reason) return true
    recordFontViewRejection(diagnostics, font, ordinal, 'frontend-row', reason, reason, reason)
    return false
  })
  return { fonts: sortVisibleFonts(options, fonts), diagnostics }
}

export function buildVisibleFonts(options: VisibleFontsOptions): FontItem[] {
  return buildVisibleFontResult(options).fonts
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
