import { observeFontRefreshPage } from '../../fontOperationTrace'
import { reportRendererTrace } from '../../rendererPerformance'
import { useEffect, useRef, useLayoutEffect, useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { FontItem } from '@shared/types'
import type { ContextMenuState, VirtualLayout, VirtualViewport } from '../../appRuntime'
import type { FontViewLayout } from './fontViewLayoutRuntime'
import { traceRendererSyncComputation } from '../../appRuntime'
import { buildTagSuggestions, buildVirtualLayout, visibleFontResultTotal } from '../../fontViewRuntime'

import { useBrowseDerivedRuntime, type BrowseDerivedOptions } from './useBrowseDerivedRuntime'

export function useAppFontDerivedRuntime(args: BrowseDerivedOptions & {
  cardPoolViewLayout: FontViewLayout
  virtualViewport: VirtualViewport
  selectedFontId: string
  selectedFontIds: string[]
  contextMenu: ContextMenuState
  previewStateForFont?: (font: FontItem) => { key?: string; family?: string; image?: string; failed?: true; loading: boolean }
  previewFamilies: Record<string, string>
  nativePreviewImages: Record<string, string>
  failedPreviewFontIds: Record<string, true>
  assignTagName: string
  assignSharedTagName: string
  latestVisibleFontsRef: MutableRefObject<FontItem[]>
  latestViewLayoutRef: MutableRefObject<{ rowHeight: number; minCardWidth: number }>
  requestPreviewFont: (font: FontItem, priority?: 'normal' | 'high', acceptsResult?: () => boolean) => void
  contextFontTargets: (available?: FontItem[]) => FontItem[]
}) {
  const { cardPoolViewLayout, virtualViewport, selectedFontId, selectedFontIds, contextMenu, previewFamilies, nativePreviewImages, failedPreviewFontIds, assignTagName, assignSharedTagName, latestVisibleFontsRef, latestViewLayoutRef, contextFontTargets, library, sidebarPage, databasePageReady, databasePageResult } = args
  const { fontIndexById, fontMetrics, localTagCounts, sharedTagCounts, localTagList, sharedTagList, flatFolderNodes, advancedFilterCount, visibleFonts } = useBrowseDerivedRuntime({
    library: args.library,
    sidebarPage: args.sidebarPage,
    databasePageReady: args.databasePageReady,
    databasePageResult: args.databasePageResult,
    databaseFontMetrics: args.databaseFontMetrics,
    allFonts: args.allFonts,
    activeFilter: args.activeFilter,
    selectedWatchedFolders: args.selectedWatchedFolders,
    selectedFormats: args.selectedFormats,
    selectedScripts: args.selectedScripts,
    selectedCategory: args.selectedCategory,
    selectedTagName: args.selectedTagName,
    selectedSharedTagName: args.selectedSharedTagName,
    selectedFolderId: args.selectedFolderId,
    installStatus: args.installStatus,
    timeSortMode: args.timeSortMode,
    sortMode: args.sortMode,
    deferredSearch: args.deferredSearch,
    expandedFolderIds: args.expandedFolderIds,
  })

  const lastQueryView = useRef('')
  useEffect(() => {
    observeFontRefreshPage(databasePageResult, databasePageReady)
    const ids = visibleFonts.map(font => font.id)
    const signature = JSON.stringify([databasePageReady, databasePageResult?.queryKey, databasePageResult?.total, ids,
      args.deferredSearch, sidebarPage, args.selectedTagName, args.selectedSharedTagName, args.selectedFolderId, cardPoolViewLayout.listLayout])
    if (lastQueryView.current === signature) return
    lastQueryView.current = signature
    const visibleIds = new Set(ids)
    const indexed = new Set(databasePageResult?.items.map(font => font.id) || [])
    reportRendererTrace({ kind: 'font-query-view', label: 'resolved-membership', page: sidebarPage, severity: 'info', details: {
      keyword: args.deferredSearch,
      keywordLength: args.deferredSearch.length,
      scope: { view: cardPoolViewLayout.listLayout === 'none' ? 'grid' : 'list', filter: args.activeFilter.kind, localTag: args.selectedTagName, sharedTag: args.selectedSharedTagName,
        folder: args.selectedFolderId, install: args.installStatus, time: args.timeSortMode, sort: args.sortMode },
      databaseReady: databasePageReady,
      databaseTotal: databasePageResult?.total ?? null,
      loaded: databasePageResult?.items.length || 0,
      visible: visibleFonts.length,
      displayTotal: databasePageReady ? visibleFontResultTotal(databasePageResult, visibleFonts) : visibleFonts.length,
      added: databasePageReady ? ids.filter(id => !indexed.has(id)).length : 0,
      removed: databasePageReady ? (databasePageResult?.items || []).filter(font => !visibleIds.has(font.id)).length : 0,
      duplicateIds: ids.length - new Set(ids).size,
      sampleIds: ids.slice(0, 3).join(',')
    } })
  }, [cardPoolViewLayout.listLayout, visibleFonts, databasePageReady, databasePageResult, args.deferredSearch, sidebarPage,
    args.activeFilter, args.selectedTagName, args.selectedSharedTagName, args.selectedFolderId, args.installStatus, args.timeSortMode, args.sortMode])

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
    rowHeight: cardPoolViewLayout.rowHeight,
    columns: cardPoolViewLayout.columns,
    rowGap: cardPoolViewLayout.rowGap,
    panelPadding: cardPoolViewLayout.panelPadding
  }), sidebarPage), [databasePageReady, databasePageResult, visibleFonts, virtualViewport, cardPoolViewLayout, sidebarPage])

  const selectedFont = useMemo(
    () => library.fonts[selectedFontId] || visibleFonts.find((item) => item.id === selectedFontId) || visibleFonts[0],
    [library.fonts, selectedFontId, visibleFonts]
  )
  const selectedPreview = selectedFont && args.previewStateForFont?.(selectedFont)
  const selectedFontPreviewFamily = selectedPreview ? selectedPreview.family || '' : selectedFont?.id ? previewFamilies[selectedFont.id] || '' : ''
  const selectedNativePreviewImage = selectedPreview ? selectedPreview.image || '' : selectedFont?.id ? nativePreviewImages[selectedFont.id] || '' : ''
  const selectedFailedPreview = selectedPreview ? selectedPreview.failed : selectedFont?.id ? failedPreviewFontIds[selectedFont.id] : undefined
  const localTagSuggestions = useMemo(() => buildTagSuggestions(library.localTags || [], selectedFont?.localTagNames, assignTagName), [assignTagName, library.localTags, selectedFont?.localTagNames])
  const sharedTagSuggestions = useMemo(() => buildTagSuggestions(library.tags || [], selectedFont?.tagNames, assignSharedTagName), [assignSharedTagName, library.tags, selectedFont?.tagNames])
  const selectedFontIdSet = useMemo(() => new Set(selectedFontIds), [selectedFontIds])
  const contextSelectedFonts = useMemo(
    () => contextFontTargets(visibleFonts),
    [contextMenu, selectedFontIds, library.fonts, visibleFonts]
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
