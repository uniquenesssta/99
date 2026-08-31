import type { FontItem } from '@shared/types'
import type { FontScrollRestoreSnapshot,VirtualViewport } from './appTypes'

export interface FontScrollLayoutState {
  minCardWidth: number
  rowHeight: number
}

export function captureFontScrollSnapshotFromNode(
  node: HTMLDivElement | null,
  fonts: FontItem[],
  layout: FontScrollLayoutState,
  viewportWidth: number,
  panelPadding: number,
  getGridColumns: (width: number, minCardWidth: number) => number,
  preferredAnchorFontId = ''
): FontScrollRestoreSnapshot {
  if (!node) return { scrollTop: null, anchor: null }

  const columns = Math.max(1, getGridColumns(node.clientWidth || viewportWidth, layout.minCardWidth))
  const rowHeight = Math.max(1, layout.rowHeight)
  const scrollTop = Math.max(0, node.scrollTop)
  const viewportBottom = scrollTop + Math.max(1, node.clientHeight)
  const topRowIndex = Math.max(0, Math.floor(Math.max(0, scrollTop - panelPadding) / rowHeight))

  let anchorIndex = Math.min(fonts.length - 1, topRowIndex * columns)
  const preferredIndex = preferredAnchorFontId ? fonts.findIndex((font) => font.id === preferredAnchorFontId) : -1
  if (preferredIndex >= 0) {
    const preferredRowIndex = Math.floor(preferredIndex / columns)
    const preferredRowTop = panelPadding + preferredRowIndex * rowHeight
    const preferredRowBottom = preferredRowTop + rowHeight
    if (preferredRowBottom >= scrollTop && preferredRowTop <= viewportBottom) {
      anchorIndex = preferredIndex
    }
  }

  const anchorFont = anchorIndex >= 0 ? fonts[anchorIndex] : null
  const rowIndex = anchorIndex >= 0 ? Math.floor(anchorIndex / columns) : topRowIndex
  const rowTop = panelPadding + rowIndex * rowHeight
  const rowOffset = Math.max(0, Math.min(rowHeight - 1, scrollTop - rowTop))
  const viewportOffset = Math.round(rowTop - scrollTop)

  return {
    scrollTop: node.scrollTop,
    anchor: anchorFont ? {
      fontId: anchorFont.id,
      rowOffset,
      rowOffsetRatio: rowOffset / rowHeight,
      viewportOffset
    } : null
  }
}

export function applyFontScrollTopToNode(
  node: HTMLDivElement | null,
  scrollTop: number,
  previousViewport: VirtualViewport
): { viewport: VirtualViewport; applied: boolean } {
  if (!node) return { viewport: previousViewport, applied: false }

  const nextScrollTop = Math.max(0, Math.min(scrollTop, Math.max(0, node.scrollHeight - node.clientHeight)))
  node.scrollTop = nextScrollTop
  return {
    applied: true,
    viewport: {
      ...previousViewport,
      scrollTop: nextScrollTop,
      height: node.clientHeight || previousViewport.height,
      width: node.clientWidth || previousViewport.width
    }
  }
}

export function scrollTopForSnapshotAnchor(
  snapshot: FontScrollRestoreSnapshot,
  node: HTMLDivElement,
  fonts: FontItem[],
  layout: FontScrollLayoutState,
  viewportWidth: number,
  panelPadding: number,
  getGridColumns: (width: number, minCardWidth: number) => number
): number | null {
  const anchor = snapshot.anchor
  if (anchor) {
    const index = fonts.findIndex((font) => font.id === anchor.fontId)
    if (index >= 0) {
      const columns = Math.max(1, getGridColumns(node.clientWidth || viewportWidth, layout.minCardWidth))
      const rowHeight = Math.max(1, layout.rowHeight)
      const rowIndex = Math.floor(index / columns)
      const rowTop = panelPadding + rowIndex * rowHeight
      if (typeof anchor.viewportOffset === 'number') return rowTop - anchor.viewportOffset
      const rowOffset = typeof anchor.rowOffsetRatio === 'number'
        ? Math.max(0, Math.min(rowHeight - 1, anchor.rowOffsetRatio * rowHeight))
        : anchor.rowOffset
      return rowTop + rowOffset
    }
  }

  return snapshot.scrollTop
}
