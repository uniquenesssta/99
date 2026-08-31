import { useEffect, useLayoutEffect, useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { FontFormat, FontItem, FontQueryPageResult, FontScript, LibraryState } from '@shared/types'
import type { ActiveFilter, ContextMenuState, FontCategory, FontComputedIndex, FontMetrics, SidebarPage, VirtualLayout, VirtualViewport } from '../../appRuntime'
import { buildFontComputedIndex, buildFontMetrics, flattenFolderNodes, PREVIEW_PREFETCH_LIMIT, traceRendererSyncComputation } from '../../appRuntime'
import { buildTagSuggestions, buildVirtualLayout, buildVisibleFonts } from '../../fontViewRuntime'
import { isFontTagStateDirty,isLibraryTagAuthorityKnown } from '../../fontTagStateAuthorityRuntime'

export function useAppFontDerivedRuntime(args: {
  library: LibraryState
  sidebarPage: SidebarPage
  databasePageReady: boolean
  databasePageResult: FontQueryPageResult | null
  databaseFontMetrics: FontMetrics | null
  allFonts: FontItem[]
  cardPoolViewLayout: { rowHeight: number; minCardWidth: number }
  virtualViewport: VirtualViewport
  activeFilter: ActiveFilter
  selectedWatchedFolders: string[]
  selectedFormats: FontFormat[]
  selectedScripts: FontScript[]
  selectedCategory: FontCategory
  selectedTagName: string
  selectedSharedTagName: string
  selectedFolderId: string
  installStatus: any
  timeSortMode: any
  sortMode: any
  deferredSearch: string
  expandedFolderIds: Record<string, true>
  selectedFontId: string
  selectedFontIds: string[]
  contextMenu: ContextMenuState
  previewFamilies: Record<string, string>
  nativePreviewImages: Record<string, string>
  failedPreviewFontIds: Record<string, true>
  assignTagName: string
  assignSharedTagName: string
  latestVisibleFontsRef: MutableRefObject<FontItem[]>
  latestViewLayoutRef: MutableRefObject<{ rowHeight: number; minCardWidth: number }>
  requestPreviewFont: (font: FontItem) => void
  contextFontTargets: () => FontItem[]
}): any {
  const {
    library,
    sidebarPage,
    databasePageReady,
    databasePageResult,
    databaseFontMetrics,
    allFonts,
    cardPoolViewLayout,
    virtualViewport,
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
    deferredSearch,
    expandedFolderIds,
    selectedFontId,
    selectedFontIds,
    contextMenu,
    previewFamilies,
    nativePreviewImages,
    failedPreviewFontIds,
    assignTagName,
    assignSharedTagName,
    latestVisibleFontsRef,
    latestViewLayoutRef,
    requestPreviewFont,
    contextFontTargets
  } = args

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

  useLayoutEffect(() => {
    latestVisibleFontsRef.current = visibleFonts
  }, [visibleFonts])

  useLayoutEffect(() => {
    latestViewLayoutRef.current = cardPoolViewLayout
  }, [cardPoolViewLayout])

  const virtualLayout = useMemo<VirtualLayout>(() => traceRendererSyncComputation('virtual-layout', { databasePageReady, visibleFonts: visibleFonts.length, viewportWidth: virtualViewport.width, viewportHeight: virtualViewport.height, scrollTop: Math.round(virtualViewport.scrollTop), rowHeight: cardPoolViewLayout.rowHeight }, () => buildVirtualLayout({
    databasePageReady,
    databasePageResult,
    visibleFonts,
    virtualViewport,
    minCardWidth: cardPoolViewLayout.minCardWidth,
    rowHeight: cardPoolViewLayout.rowHeight
  }), sidebarPage), [databasePageReady, databasePageResult, visibleFonts, virtualViewport, cardPoolViewLayout.rowHeight, cardPoolViewLayout.minCardWidth, sidebarPage])

  const previewPrefetchFonts = useMemo(
    () => virtualLayout.items.slice(0, PREVIEW_PREFETCH_LIMIT),
    [virtualLayout.items]
  )
  const previewPrefetchKey = useMemo(
    () => previewPrefetchFonts.map((font) => `${font.id}:${font.__earlyVisible ? 'early' : 'ready'}`).join('|'),
    [previewPrefetchFonts]
  )

  useEffect(() => {
    for (const font of previewPrefetchFonts) {
      if (font.__earlyVisible) continue
      requestPreviewFont(font)
    }
  }, [previewPrefetchKey, library.previewText])

  const selectedFont = useMemo(
    () => library.fonts[selectedFontId] || visibleFonts.find((item) => item.id === selectedFontId) || visibleFonts[0],
    [library.fonts, selectedFontId, visibleFonts]
  )
  const selectedFontPreviewFamily = selectedFont?.id ? previewFamilies[selectedFont.id] || '' : ''
  const selectedNativePreviewImage = selectedFont?.id ? nativePreviewImages[selectedFont.id] || '' : ''
  const selectedFailedPreview = selectedFont?.id ? failedPreviewFontIds[selectedFont.id] : undefined
  const localTagSuggestions = useMemo(() => buildTagSuggestions(library.localTags || [], selectedFont?.localTagNames, assignTagName), [assignTagName, library.localTags, selectedFont?.localTagNames])
  const sharedTagSuggestions = useMemo(() => buildTagSuggestions(library.tags || [], selectedFont?.tagNames, assignSharedTagName), [assignSharedTagName, library.tags, selectedFont?.tagNames])
  const selectedFontIdSet = useMemo(() => new Set(selectedFontIds), [selectedFontIds])
  const contextSelectedFonts = useMemo(
    () => contextFontTargets(),
    [contextMenu, selectedFontIds, library.fonts]
  )

  return {
    fontIndexById,
    fontMetrics,
    favoriteCount: fontMetrics.favoriteCount,
    installedCount: fontMetrics.installedCount,
    notInstalledCount: fontMetrics.notInstalledCount,
    installStatusMissingCount: fontMetrics.installStatusMissingCount || 0,
    installStatusReady: fontMetrics.installStatusReady !== false && (fontMetrics.installStatusMissingCount || 0) === 0,
    activeCount: fontMetrics.activeCount,
    formatCounts: fontMetrics.formatCounts,
    categoryCounts: fontMetrics.categoryCounts,
    scriptCounts: fontMetrics.scriptCounts,
    localTagCounts,
    sharedTagCounts,
    localTagList,
    sharedTagList,
    flatFolderNodes,
    folderCounts: fontMetrics.folderCounts,
    advancedFilterCount,
    visibleFonts,
    virtualLayout,
    selectedFont,
    selectedFontPreviewFamily,
    selectedNativePreviewImage,
    selectedFailedPreview,
    localTagSuggestions,
    sharedTagSuggestions,
    selectedFontIdSet,
    contextSelectedFonts
  }
}
