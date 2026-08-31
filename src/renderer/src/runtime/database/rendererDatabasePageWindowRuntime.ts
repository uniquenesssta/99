import { getVirtualGridColumns } from '../../appRuntime'

export const DATABASE_INCREMENTAL_PAGE_SIZE = 100

export function buildRendererDatabasePageWindow(options: {
  width: number
  height: number
  scrollTop: number
  rowHeight: number
  minCardWidth: number
  pageOffset?: number
}): {
  columns: number
  offset: number
  limit: number
} {
  const columns = Math.max(1, getVirtualGridColumns(options.width, options.minCardWidth))
  const offset = Math.max(0, Math.floor(Number(options.pageOffset || 0) / DATABASE_INCREMENTAL_PAGE_SIZE) * DATABASE_INCREMENTAL_PAGE_SIZE)
  return { columns, offset, limit: DATABASE_INCREMENTAL_PAGE_SIZE }
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
