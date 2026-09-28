import { getVirtualGridColumns } from '../../appRuntime'
import { VIRTUAL_PANEL_PADDING } from '../../constants/layoutConstants'

export const DATABASE_INCREMENTAL_PAGE_SIZE = 100

export function buildRendererDatabasePageWindow(options: {
  width: number
  height: number
  scrollTop: number
  rowHeight: number
  minCardWidth: number
  columns?: number
  pageOffset?: number
}): {
  columns: number
  offset: number
  limit: number
} {
  const columns = Math.max(1, options.columns ?? getVirtualGridColumns(options.width, options.minCardWidth))
  const offset = Math.max(0, Math.floor(Number(options.pageOffset || 0) / DATABASE_INCREMENTAL_PAGE_SIZE) * DATABASE_INCREMENTAL_PAGE_SIZE)
  return { columns, offset, limit: DATABASE_INCREMENTAL_PAGE_SIZE }
}

/** Request the visible page after a fast jump, or the adjacent page near an edge. */
export function rendererDatabaseViewportPageOffset(options: {
  offset: number; loadedItems: number; totalItems: number
  viewportHeight: number; scrollTop: number; rowHeight: number; columns: number
}): number | null {
  const columns = Math.max(1, options.columns)
  const first = Math.max(0, Math.floor(Math.max(0, options.scrollTop - VIRTUAL_PANEL_PADDING) / Math.max(1, options.rowHeight))) * columns
  const end = options.offset + options.loadedItems
  if (first < options.offset || first >= end) {
    const target = Math.min(first, Math.max(0, options.totalItems - 1))
    return Math.floor(target / DATABASE_INCREMENTAL_PAGE_SIZE) * DATABASE_INCREMENTAL_PAGE_SIZE
  }
  if (end < options.totalItems && shouldGrowRendererDatabasePage({ ...options,
    loadedItems: end })) return Math.floor(end / DATABASE_INCREMENTAL_PAGE_SIZE) * DATABASE_INCREMENTAL_PAGE_SIZE
  return null
}

export function shouldGrowRendererDatabasePage(options: {
  loadedItems: number
  totalItems: number
  viewportHeight: number
  scrollTop: number
  rowHeight: number
  columns: number
}): boolean {
  if (options.loadedItems <= 0) return false
  if (options.loadedItems >= options.totalItems) return false
  const columns = Math.max(1, options.columns)
  const loadedRows = Math.ceil(options.loadedItems / columns)
  const loadedHeight = loadedRows * Math.max(1, options.rowHeight)
  const viewportBottom = Math.max(0, options.scrollTop) + Math.max(1, options.viewportHeight)
  const preloadDistance = Math.max(260, options.rowHeight * 1.6)
  return viewportBottom >= loadedHeight - preloadDistance
}

export function nextRendererDatabasePageOffset(loadedItems: number, totalItems: number): number {
  if (loadedItems <= 0) return 0
  if (totalItems > 0 && loadedItems >= totalItems) return Math.max(0, totalItems)
  return Math.max(DATABASE_INCREMENTAL_PAGE_SIZE, Math.floor(loadedItems / DATABASE_INCREMENTAL_PAGE_SIZE) * DATABASE_INCREMENTAL_PAGE_SIZE)
}
