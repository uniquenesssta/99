import type { CardPoolViewMode, ViewMode } from '../../appTypes'
import { getVirtualGridColumns, VIEW_MODE_LAYOUT, VIRTUAL_GRID_GAP, VIRTUAL_PANEL_PADDING } from '../../constants/layoutConstants'
import { listPreviewFontSizeRowHeightPadding } from '../preview/listPreviewSizeRuntime'

export type FontViewLayout = {
  /** Legacy consumer name: distance between row starts, NOT the card height. */
  rowHeight: number
  cardHeight: number
  rowGap: number
  minCardWidth: number
  columns: number
  panelPadding: number
  listLayout: 'wide' | 'medium' | 'stacked' | 'none'
  cardPaddingY: number
  cardPaddingX: number
  previewHeight: number
  infoHeight: number
  innerRowGap: number
}

export function buildFontViewLayout(mode: CardPoolViewMode, density: ViewMode, width: number, fontSize: number, lineCount: number): FontViewLayout {
  const grid = VIEW_MODE_LAYOUT[density]
  if (mode !== 'list') return {
    ...grid,
    cardHeight: grid.rowHeight - VIRTUAL_GRID_GAP,
    rowGap: VIRTUAL_GRID_GAP,
    columns: getVirtualGridColumns(width, grid.minCardWidth),
    panelPadding: VIRTUAL_PANEL_PADDING,
    listLayout: 'none', cardPaddingY: 0, cardPaddingX: 0, previewHeight: 0, infoHeight: 0, innerRowGap: 0
  }

  const listLayout = width < 720 ? 'stacked' : width < 1180 ? 'medium' : 'wide'
  const multiline = lineCount > 1
  const base = listLayout === 'wide'
    ? multiline ? { compact: 148, comfortable: 176, large: 204 } : { compact: 118, comfortable: 140, large: 176 }
    : multiline ? { compact: 144, comfortable: 166, large: 194 } : { compact: 114, comfortable: 132, large: 162 }
  const cardPaddingY = density === 'compact' ? 8 : density === 'large' ? 12 : 10
  const cardPaddingX = listLayout === 'wide' ? 16 : 12
  // Stacked cards allocate a separate information row. Its space must not also
  // be counted as preview space (the former rowHeight - 32 rule did this).
  const previewHeight = Math.max(86, base[density] - cardPaddingY * 2 - 2)
    + listPreviewFontSizeRowHeightPadding(fontSize, density, lineCount)
  const infoHeight = listLayout === 'stacked' ? 104 : 0
  const innerRowGap = listLayout === 'stacked' ? 8 : 0
  const cardHeight = cardPaddingY * 2 + 2 + previewHeight + infoHeight + innerRowGap
  const rowGap = listLayout === 'wide' ? 12 : 10
  return {
    rowHeight: cardHeight + rowGap, cardHeight, rowGap,
    minCardWidth: 9999, columns: 1, panelPadding: VIRTUAL_PANEL_PADDING,
    listLayout, cardPaddingY, cardPaddingX, previewHeight, infoHeight, innerRowGap
  }
}
