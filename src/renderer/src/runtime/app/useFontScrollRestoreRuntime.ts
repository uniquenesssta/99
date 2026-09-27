import type { FontItem } from '@shared/types'
import { useLayoutEffect, useRef } from 'react'
import type { FontViewLayout } from './fontViewLayoutRuntime'
import { getVirtualGridColumns, VIRTUAL_PANEL_PADDING } from '../../constants/layoutConstants'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { FontScrollRestoreSnapshot,ViewMode,VirtualViewport } from '../../appRuntime'
import {
applyFontScrollTopToNode,
captureFontScrollSnapshotFromNode,
scrollTopForSnapshotAnchor,
type FontScrollLayoutState
} from '../../fontScrollRuntime'

/** Preserve the committed font anchor when geometry changes without an explicit
 * toolbar command (preview size, container resize, or detail docking). */
export function useFontLayoutScrollAnchor(options: {
  layout: FontViewLayout
  fonts: FontItem[]
  viewport: VirtualViewport
  fontScrollerRef: MutableRefObject<HTMLDivElement | null>
  setVirtualViewport: Dispatch<SetStateAction<VirtualViewport>>
  preferredFontId: string
  enabled: boolean
}): void {
  const previous = useRef<typeof options | null>(null)
  useLayoutEffect(() => {
    const before = previous.current
    previous.current = options
    const node = options.fontScrollerRef.current
    if (!before || !node || !before.enabled || !options.enabled) return
    if (before.layout.rowHeight === options.layout.rowHeight && before.layout.columns === options.layout.columns) return
    // Filter/sort/page changes own their own reset. Only preserve an anchor in
    // the same ordered result (incremental append is also safe).
    if (!before.fonts.length || before.fonts.length > options.fonts.length ||
      before.fonts.some((font, index) => font.id !== options.fonts[index]?.id)) return
    const snapshot = captureFontScrollSnapshotFromNode({
      scrollTop: before.viewport.scrollTop,
      clientWidth: before.viewport.width,
      clientHeight: before.viewport.height
    } as HTMLDivElement, before.fonts, before.layout, before.viewport.width,
    VIRTUAL_PANEL_PADDING, getVirtualGridColumns, options.preferredFontId)
    const scrollTop = scrollTopForSnapshotAnchor(snapshot, node, options.fonts,
      options.layout, options.viewport.width, VIRTUAL_PANEL_PADDING, getVirtualGridColumns)
    if (scrollTop === null) return
    const result = applyFontScrollTopToNode(node, scrollTop, options.viewport)
    previous.current = { ...options, viewport: result.viewport }
    if (result.viewport.scrollTop !== options.viewport.scrollTop) options.setVirtualViewport(result.viewport)
  }, [options.layout, options.fonts, options.viewport, options.enabled, options.preferredFontId, options.fontScrollerRef, options.setVirtualViewport])
}

export function createAppFontScrollRestoreRuntime(options: {
  fontScrollerRef: MutableRefObject<HTMLDivElement | null>
  latestVisibleFontsRef: MutableRefObject<FontItem[]>
  latestViewLayoutRef: MutableRefObject<FontScrollLayoutState>
  virtualViewportWidth: number
  setVirtualViewport: Dispatch<SetStateAction<VirtualViewport>>
  panelPadding: number
  getVirtualGridColumns: (width: number, minCardWidth: number) => number
  viewMode: ViewMode
  selectedFontId?: string
  updatePageToolbar: (key: 'viewMode', value: ViewMode) => void
}) {
  function captureFontScrollSnapshot(preferredFontId = options.selectedFontId || ''): FontScrollRestoreSnapshot {
    return captureFontScrollSnapshotFromNode(
      options.fontScrollerRef.current,
      options.latestVisibleFontsRef.current,
      options.latestViewLayoutRef.current,
      options.virtualViewportWidth,
      options.panelPadding,
      options.getVirtualGridColumns,
      preferredFontId
    )
  }

  function applyFontScrollTop(scrollTop: number): void {
    options.setVirtualViewport((prev) => applyFontScrollTopToNode(options.fontScrollerRef.current, scrollTop, prev).viewport)
  }

  function restoreFontScrollTop(scrollTop: number): void {
    window.requestAnimationFrame(() => applyFontScrollTop(scrollTop))
  }

  function restoreFontScrollSnapshot(snapshot: FontScrollRestoreSnapshot): void {
    window.requestAnimationFrame(() => {
      const node = options.fontScrollerRef.current
      if (!node) return
      const scrollTop = scrollTopForSnapshotAnchor(
        snapshot,
        node,
        options.latestVisibleFontsRef.current,
        options.latestViewLayoutRef.current,
        options.virtualViewportWidth,
        options.panelPadding,
        options.getVirtualGridColumns
      )
      if (scrollTop !== null) applyFontScrollTop(scrollTop)
    })
  }

  function updateViewModeWithScroll(nextViewMode: ViewMode): void {
    if (nextViewMode === options.viewMode) return
    const snapshot = captureFontScrollSnapshot()
    options.updatePageToolbar('viewMode', nextViewMode)
    restoreFontScrollSnapshot(snapshot)
  }

  function runAfterScrollPreservingMutation(mutator: () => void, preferredFontId = options.selectedFontId || ''): void {
    const snapshot = captureFontScrollSnapshot(preferredFontId)
    mutator()
    restoreFontScrollSnapshot(snapshot)
  }

  return {
    captureFontScrollSnapshot,
    applyFontScrollTop,
    restoreFontScrollTop,
    restoreFontScrollSnapshot,
    updateViewModeWithScroll,
    runAfterScrollPreservingMutation
  }
}
