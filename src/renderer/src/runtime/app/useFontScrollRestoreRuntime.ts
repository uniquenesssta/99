import type { FontItem } from '@shared/types'
import type { Dispatch,MutableRefObject,SetStateAction } from 'react'
import type { FontScrollRestoreSnapshot,ViewMode,VirtualViewport } from '../../appRuntime'
import {
applyFontScrollTopToNode,
captureFontScrollSnapshotFromNode,
scrollTopForSnapshotAnchor,
type FontScrollLayoutState
} from '../../fontScrollRuntime'

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
