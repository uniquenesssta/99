import { useEffect, useLayoutEffect, useMemo } from 'react'
import type { MutableRefObject } from 'react'
import type { FontItem } from '@shared/types'
import type { ContextMenuState, VirtualLayout, VirtualViewport } from '../../appRuntime'
import { PREVIEW_PREFETCH_LIMIT, traceRendererSyncComputation } from '../../appRuntime'
import { buildTagSuggestions, buildVirtualLayout } from '../../fontViewRuntime'

import { useBrowseDerivedRuntime, type BrowseDerivedOptions } from './useBrowseDerivedRuntime'

export function useAppFontDerivedRuntime(args: BrowseDerivedOptions & {
  cardPoolViewLayout: { rowHeight: number; minCardWidth: number }
  virtualViewport: VirtualViewport
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
}) {
  const { cardPoolViewLayout, virtualViewport, selectedFontId, selectedFontIds, contextMenu, previewFamilies, nativePreviewImages, failedPreviewFontIds, assignTagName, assignSharedTagName, latestVisibleFontsRef, latestViewLayoutRef, requestPreviewFont, contextFontTargets, library, sidebarPage, databasePageReady, databasePageResult } = args
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
