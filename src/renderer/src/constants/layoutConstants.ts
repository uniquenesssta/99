import type { ViewMode } from '../appTypes'

export const VIRTUAL_OVERSCAN_ROWS = 4
export const VIRTUAL_GRID_GAP = 14
export const VIRTUAL_WATERFALL_ROW_HEIGHT = 342
export const VIRTUAL_MIN_CARD_WIDTH = 245
export const VIRTUAL_PANEL_PADDING = 14
export const CONTEXT_MENU_WIDTH = 190
export const CONTEXT_MENU_MAX_HEIGHT = 360

export const VIEW_MODE_LAYOUT: Record<ViewMode, { rowHeight: number; minCardWidth: number }> = {
  compact: { rowHeight: 266, minCardWidth: 218 },
  comfortable: { rowHeight: VIRTUAL_WATERFALL_ROW_HEIGHT, minCardWidth: VIRTUAL_MIN_CARD_WIDTH },
  large: { rowHeight: 386, minCardWidth: 292 }
}

export function getVirtualGridColumns(width: number, minCardWidth: number): number {
  const availableWidth = Math.max(320, width - VIRTUAL_PANEL_PADDING * 2)
  return Math.max(1, Math.floor((availableWidth + VIRTUAL_GRID_GAP) / (minCardWidth + VIRTUAL_GRID_GAP)))
}
