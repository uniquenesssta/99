import { useMemo } from 'react'
import type { FontItem, LibraryState } from '@shared/types'
import type { CardPoolViewMode, PageToolbarState, SidebarPage, VirtualViewport } from '../../appRuntime'
import { traceRendererSyncComputation, VIEW_MODE_LAYOUT } from '../../appRuntime'
import { previewTextLines } from '@shared/preview-layout/previewTextFitRuntime'
import { listPreviewFontSizeRowHeightPadding } from '../preview/listPreviewSizeRuntime'

export function useAppFontShellDerivedRuntime(args: {
  library: LibraryState
  sidebarPage: SidebarPage
  viewMode: PageToolbarState['viewMode']
  cardPoolViewMode: CardPoolViewMode
  listPreviewFontSize: number
  virtualViewport: VirtualViewport
}): {
  viewLayout: { rowHeight: number; minCardWidth: number }
  listPreviewLineCount: number
  cardPoolViewLayout: { rowHeight: number; minCardWidth: number }
  allFonts: FontItem[]
} {
  const { library, sidebarPage, viewMode, cardPoolViewMode, listPreviewFontSize, virtualViewport } = args
  const viewLayout = VIEW_MODE_LAYOUT[viewMode]
  const listPreviewLineCount = useMemo(() => previewTextLines(library.previewText, 2).length, [library.previewText])
  const cardPoolViewLayout = useMemo(() => {
    if (cardPoolViewMode !== 'list') return viewLayout
    const hasMultilinePreview = listPreviewLineCount > 1
    const wideRowHeight = hasMultilinePreview
      ? viewMode === 'large' ? 204 : viewMode === 'compact' ? 148 : 176
      : viewMode === 'large' ? 176 : viewMode === 'compact' ? 118 : 140
    const mediumRowHeight = hasMultilinePreview
      ? viewMode === 'large' ? 194 : viewMode === 'compact' ? 144 : 166
      : viewMode === 'large' ? 162 : viewMode === 'compact' ? 114 : 132
    const stackedRowHeight = hasMultilinePreview
      ? viewMode === 'large' ? 264 : viewMode === 'compact' ? 216 : 236
      : viewMode === 'large' ? 244 : viewMode === 'compact' ? 194 : 214
    const baseRowHeight = virtualViewport.width < 720 ? stackedRowHeight : virtualViewport.width < 1180 ? mediumRowHeight : wideRowHeight
    const rowHeight = baseRowHeight + listPreviewFontSizeRowHeightPadding(listPreviewFontSize, viewMode, listPreviewLineCount)
    return { rowHeight, minCardWidth: 9999 }
  }, [cardPoolViewMode, listPreviewFontSize, listPreviewLineCount, viewLayout, viewMode, virtualViewport.width])

  const allFonts = useMemo(() => traceRendererSyncComputation('all-fonts-object-values', { fontObjectKeys: Object.keys(library.fonts || {}).length }, () => Object.values(library.fonts || {}), sidebarPage), [library.fonts, sidebarPage])

  return { viewLayout, listPreviewLineCount, cardPoolViewLayout, allFonts }
}
