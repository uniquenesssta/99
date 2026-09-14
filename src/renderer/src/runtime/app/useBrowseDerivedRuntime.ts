import { useMemo } from 'react'
import type { FontFormat, FontItem, FontQueryPageResult, FontScript, LibraryState } from '@shared/types'
import type { ActiveFilter, FontCategory, FontComputedIndex, FontMetrics, SidebarPage, InstallStatusFilter, TimeSortMode, SortMode } from '../../appRuntime'
import { buildFontComputedIndex, buildFontMetrics, flattenFolderNodes, traceRendererSyncComputation } from '../../appRuntime'
import { buildVisibleFonts } from '../../fontViewRuntime'
import { isFontTagStateDirty, isLibraryTagAuthorityKnown } from '../../fontTagStateAuthorityRuntime'

export type BrowseDerivedOptions = {
  library: LibraryState
  sidebarPage: SidebarPage
  databasePageReady: boolean
  databasePageResult: FontQueryPageResult | null
  databaseFontMetrics: FontMetrics | null
  allFonts: FontItem[]
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
  deferredSearch: string
  expandedFolderIds: Record<string, true>
}

// Read-only derivation; selection, preview effects and mutable refs stay with their owners.
export function useBrowseDerivedRuntime(args: BrowseDerivedOptions) {
  const { library, sidebarPage, databasePageReady, databasePageResult, databaseFontMetrics, allFonts, activeFilter, selectedWatchedFolders, selectedFormats, selectedScripts, selectedCategory, selectedTagName, selectedSharedTagName, selectedFolderId, installStatus, timeSortMode, sortMode, deferredSearch, expandedFolderIds } = args

  const fontIndexById = useMemo(() => {
    const sourceFonts = databasePageReady && databaseFontMetrics
      ? databasePageResult?.items || []
      : allFonts
    return traceRendererSyncComputation('font-index-by-id', { fonts: sourceFonts.length, mode: databasePageReady && databaseFontMetrics ? 'database-page-window' : 'frontend-window' }, () => {
      const map = new Map<string, FontComputedIndex>()
      for (const font of sourceFonts) {
        map.set(font.id, buildFontComputedIndex(font))
      }
      return map
    }, sidebarPage)
  }, [databasePageReady, databaseFontMetrics, databasePageResult?.items, allFonts, sidebarPage])

  const fontMetrics = useMemo(
    () => databaseFontMetrics || traceRendererSyncComputation('frontend-build-font-metrics', { fonts: allFonts.length, collections: library.collections.length, tags: library.tags.length, folders: library.folders.length }, () => buildFontMetrics(allFonts, fontIndexById, library), sidebarPage),
    [databaseFontMetrics, allFonts, fontIndexById, library.collections, library.tags, library.localTags, library.folders, library.folderNodes, library.fontFolderIds, sidebarPage]
  )

  const localTagCounts = useMemo(() => {
    const metricCounts = fontMetrics.localTagCounts || {}
    const authoritative = isLibraryTagAuthorityKnown(library, 'local')
    const authoritativeTags = new Set((library.localTags || []).map((tag) => String(tag || '').trim()).filter(Boolean))
    const tagNames = new Set<string>(authoritativeTags)
    const optimisticCounts: Record<string, number> = {}
    for (const tag of Object.keys(metricCounts)) {
      const cleanTag = String(tag || '').trim()
      if (!cleanTag || Number(metricCounts[tag] || 0) <= 0) continue
      if (!authoritative || authoritativeTags.has(cleanTag)) tagNames.add(cleanTag)
    }
    const acceptedTags = new Set(tagNames)
    for (const font of allFonts) {
      if (!isFontTagStateDirty(font, 'local')) continue
      for (const tag of font.localTagNames || []) {
        const cleanTag = String(tag || '').trim()
        if (cleanTag && (!authoritative || authoritativeTags.has(cleanTag))) acceptedTags.add(cleanTag)
      }
    }
    for (const font of allFonts) {
      for (const tag of font.localTagNames || []) {
        const cleanTag = String(tag || '').trim()
        if (!cleanTag || !acceptedTags.has(cleanTag)) continue
        tagNames.add(cleanTag)
        optimisticCounts[cleanTag] = (optimisticCounts[cleanTag] || 0) + 1
      }
    }

    const counts: Record<string, number> = {}
    for (const tag of tagNames) counts[tag] = Math.max(metricCounts[tag] || 0, optimisticCounts[tag] || 0)
    return counts
  }, [fontMetrics.localTagCounts, library.localTags, library.__localTagAuthorityKnown, allFonts])

  const sharedTagCounts = useMemo(() => {
    const metricCounts = fontMetrics.sharedTagCounts || {}
    const authoritative = isLibraryTagAuthorityKnown(library, 'shared')
    const authoritativeTags = new Set((library.tags || []).map((tag) => String(tag || '').trim()).filter(Boolean))
    const tagNames = new Set<string>(authoritativeTags)
    const optimisticCounts: Record<string, number> = {}
    for (const tag of Object.keys(metricCounts)) {
      const cleanTag = String(tag || '').trim()
      if (!cleanTag || Number(metricCounts[tag] || 0) <= 0) continue
      if (!authoritative || authoritativeTags.has(cleanTag)) tagNames.add(cleanTag)
    }
    for (const font of allFonts) {
      for (const tag of font.tagNames || []) {
        const cleanTag = String(tag || '').trim()
        if (!cleanTag || (authoritative && !authoritativeTags.has(cleanTag))) continue
        tagNames.add(cleanTag)
        optimisticCounts[cleanTag] = (optimisticCounts[cleanTag] || 0) + 1
      }
    }

    const counts: Record<string, number> = {}
    for (const tag of tagNames) counts[tag] = Math.max(metricCounts[tag] || 0, optimisticCounts[tag] || 0)
    return counts
  }, [fontMetrics.sharedTagCounts, library.tags, library.__sharedTagAuthorityKnown, allFonts])

  const localTagList = useMemo(() => Object.keys(localTagCounts).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')), [localTagCounts])
  const sharedTagList = useMemo(() => Object.keys(sharedTagCounts).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')), [sharedTagCounts])
  const flatFolderNodes = useMemo(() => flattenFolderNodes(library, expandedFolderIds), [library.folders, library.folderNodes, expandedFolderIds])
  const advancedFilterCount = selectedWatchedFolders.length + selectedFormats.length + selectedScripts.length + (selectedCategory === 'all' ? 0 : 1)

  const visibleFonts = useMemo(() => traceRendererSyncComputation('visible-fonts-filter-sort', { mode: databasePageReady ? 'database-page' : 'frontend-fallback', fonts: allFonts.length, page: sidebarPage, searchLength: deferredSearch.length, installStatus, sortMode, timeSortMode, selectedFolderId, selectedTagName, selectedSharedTagName }, () => buildVisibleFonts({
    databasePageReady,
    databasePageResult,
    allFonts,
    fontIndexById,
    deferredSearch,
    activeFilter,
    selectedWatchedFolders,
    selectedFormats,
    selectedScripts,
    selectedCategory,
    selectedTagName,
    selectedSharedTagName,
    selectedFolderId,
    installStatus,
    timeSortMode,
    sortMode,
    sidebarPage,
    library
  }), sidebarPage), [databasePageReady, databasePageResult, allFonts, fontIndexById, deferredSearch, activeFilter, selectedWatchedFolders, selectedFormats, selectedScripts, selectedCategory, selectedTagName, selectedSharedTagName, selectedFolderId, installStatus, timeSortMode, sortMode, sidebarPage, library])

  return { fontIndexById, fontMetrics, localTagCounts, sharedTagCounts, localTagList, sharedTagList, flatFolderNodes, advancedFilterCount, visibleFonts }
}
