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
  detailVisible?: boolean
  scopeKey?: string
  fontOffset?: number
}): (visible: boolean) => void {
  const previous = useRef<typeof options | null>(null)
  type DetailPosition = { snapshot: FontScrollRestoreSnapshot; horizontal: Map<string, number>; scopeKey?: string }
  const entry = useRef<DetailPosition | null>(null)
  const transition = useRef<DetailPosition | null>(null)
  const horizontalRestore = useRef<Map<string, number> | null>(null)

  useLayoutEffect(() => {
    const before = previous.current
    const node = options.fontScrollerRef.current
    if (!before || !node || !before.enabled || !options.enabled || before.scopeKey !== options.scopeKey) {
      previous.current = options
      entry.current = transition.current = null
      horizontalRestore.current = null
      return
    }
    // Keep the last committed geometry until docking's synchronous measurement
    // has reached the virtual layout. Never anchor using mixed old/new widths.
    if (transition.current && (node.clientWidth !== options.viewport.width || node.clientHeight !== options.viewport.height)) return
    previous.current = options
    if (horizontalRestore.current) {
      for (const card of node.querySelectorAll<HTMLElement>('[data-font-id]')) {
        const left = horizontalRestore.current.get(card.dataset.fontId || '')
        const preview = card.querySelector<HTMLElement>('.list-preview-scroll')
        if (left !== undefined && preview) preview.scrollLeft = left
      }
      horizontalRestore.current = null
    }
    const detail = transition.current
    transition.current = null
    if (!detail && before.layout.rowHeight === options.layout.rowHeight && before.layout.columns === options.layout.columns) return
    // Filter/sort/page changes own their reset. Detail return uses a scoped
    // entry snapshot, independent of the currently selected font or page slice.
    if (!detail && (!before.fonts.length || before.fontOffset !== options.fontOffset || before.fonts.length > options.fonts.length ||
      before.fonts.some((font, index) => font.id !== options.fonts[index]?.id))) return
    const snapshot = detail?.snapshot || captureFontScrollSnapshotFromNode({
      scrollTop: before.viewport.scrollTop,
      clientWidth: before.viewport.width,
      clientHeight: before.viewport.height
    } as HTMLDivElement, before.fonts, before.layout, before.viewport.width,
    VIRTUAL_PANEL_PADDING, getVirtualGridColumns, options.preferredFontId, before.fontOffset)
    const scrollTop = scrollTopForSnapshotAnchor(snapshot, node, options.fonts,
      options.layout, options.viewport.width, VIRTUAL_PANEL_PADDING, getVirtualGridColumns, options.fontOffset)
    if (scrollTop === null) return
    const result = applyFontScrollTopToNode(node, scrollTop, options.viewport)
    previous.current = { ...options, viewport: result.viewport }
    if (detail) {
      // The restored virtual slice may mount in the following synchronous commit.
      horizontalRestore.current = result.viewport.scrollTop !== options.viewport.scrollTop ? detail.horizontal : null
      for (const card of node.querySelectorAll<HTMLElement>('[data-font-id]')) {
        const preview = card.querySelector<HTMLElement>('.list-preview-scroll')
        const left = detail.horizontal.get(card.dataset.fontId || '')
        if (preview && left !== undefined) preview.scrollLeft = left
      }
    }
    if (result.viewport.scrollTop !== options.viewport.scrollTop) options.setVirtualViewport(result.viewport)
  }, [options.layout, options.fonts, options.viewport, options.enabled, options.preferredFontId, options.fontScrollerRef, options.setVirtualViewport, options.detailVisible, options.scopeKey, options.fontOffset])

  // Called by the selection owner BEFORE React changes docking. Capturing here
  // also preserves bottom-of-list positions before the browser clamps scrollTop.
  return (visible: boolean): void => {
    const node = options.fontScrollerRef.current
    if (!node || !options.enabled) return
    const horizontal = new Map<string, number>()
    for (const card of node.querySelectorAll<HTMLElement>('[data-font-id]')) {
      const preview = card.querySelector<HTMLElement>('.list-preview-scroll')
      if (preview) horizontal.set(card.dataset.fontId || '', preview.scrollLeft)
    }
    const position = {
      snapshot: captureFontScrollSnapshotFromNode(node, options.fonts, options.layout, options.viewport.width,
        VIRTUAL_PANEL_PADDING, getVirtualGridColumns, '', options.fontOffset),
      horizontal, scopeKey: options.scopeKey
    }
    if (visible) entry.current = position
    transition.current = !visible && entry.current?.scopeKey === options.scopeKey ? entry.current : position
    if (!visible) entry.current = null
  }
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
