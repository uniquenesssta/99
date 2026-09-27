import { useMemo } from 'react'
import type { FontItem, LibraryState } from '@shared/types'
import type { CardPoolViewMode, PageToolbarState, SidebarPage, VirtualViewport } from '../../appRuntime'
import { traceRendererSyncComputation, VIEW_MODE_LAYOUT } from '../../appRuntime'
import { previewTextLines } from '@shared/preview-layout/previewTextFitRuntime'
import { buildFontViewLayout, type FontViewLayout } from './fontViewLayoutRuntime'

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
  cardPoolViewLayout: FontViewLayout
  allFonts: FontItem[]
} {
  const { library, sidebarPage, viewMode, cardPoolViewMode, listPreviewFontSize, virtualViewport } = args
  const viewLayout = VIEW_MODE_LAYOUT[viewMode]
  const listPreviewLineCount = useMemo(() => previewTextLines(library.previewText, 2).length, [library.previewText])
  const cardPoolViewLayout = useMemo(() => buildFontViewLayout(
    cardPoolViewMode, viewMode, virtualViewport.width, listPreviewFontSize, listPreviewLineCount
  ), [cardPoolViewMode, viewMode, virtualViewport.width, listPreviewFontSize, listPreviewLineCount])

  const allFonts = useMemo(() => traceRendererSyncComputation('all-fonts-object-values', { fontObjectKeys: Object.keys(library.fonts || {}).length }, () => Object.values(library.fonts || {}), sidebarPage), [library.fonts, sidebarPage])

  return { viewLayout, listPreviewLineCount, cardPoolViewLayout, allFonts }
}
