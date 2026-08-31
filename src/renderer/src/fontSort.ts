import type { FontItem } from '@shared/types'
import type { SortMode,TimeSortMode } from './appTypes'
import { fontDisplayName,isInstalled } from './fontDisplay'

export function fontCreatedAtMs(font: FontItem): number {
  if (typeof font.createdAt === 'number' && Number.isFinite(font.createdAt)) return font.createdAt
  const added = Date.parse(font.addedAt || '')
  if (Number.isFinite(added)) return added
  return font.modifiedAt || 0
}

export function timeRangeStartMs(_mode: TimeSortMode): number {
  return 0
}

export function isTimeRangeMode(_mode: TimeSortMode): boolean {
  return false
}

export function inTimeSortRange(font: FontItem, mode: TimeSortMode): boolean {
  if (!isTimeRangeMode(mode)) return true

  const time = typeof font.modifiedAt === 'number' && Number.isFinite(font.modifiedAt)
    ? font.modifiedAt
    : fontCreatedAtMs(font)

  if (!time) return false
  return time >= timeRangeStartMs(mode)
}

export function compareFontsForTimeSort(a: FontItem, b: FontItem, mode: TimeSortMode): number {
  if (mode === 'created') return fontCreatedAtMs(b) - fontCreatedAtMs(a) || compareByName(a, b)
  return (b.modifiedAt || 0) - (a.modifiedAt || 0) || compareByName(a, b)
}

export function compareByName(a: FontItem, b: FontItem): number {
  return fontDisplayName(a).localeCompare(fontDisplayName(b), 'zh-Hans-CN')
}

export function compareFontsForSort(a: FontItem, b: FontItem, sortMode: SortMode): number {
  if (sortMode === 'nameAsc') return compareByName(a, b)
  if (sortMode === 'nameDesc') return compareByName(b, a)
  if (sortMode === 'createdDesc') return fontCreatedAtMs(b) - fontCreatedAtMs(a) || compareByName(a, b)
  if (sortMode === 'createdAsc') return fontCreatedAtMs(a) - fontCreatedAtMs(b) || compareByName(a, b)
  if (sortMode === 'modifiedDesc') return (b.modifiedAt || 0) - (a.modifiedAt || 0) || compareByName(a, b)
  if (sortMode === 'modifiedAsc') return (a.modifiedAt || 0) - (b.modifiedAt || 0) || compareByName(a, b)
  if (sortMode === 'sizeDesc') return (b.fileSize || 0) - (a.fileSize || 0) || compareByName(a, b)
  if (sortMode === 'sizeAsc') return (a.fileSize || 0) - (b.fileSize || 0) || compareByName(a, b)

  if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
  if (a.active !== b.active) return a.active ? -1 : 1
  if (isInstalled(a) !== isInstalled(b)) return isInstalled(a) ? -1 : 1
  return compareByName(a, b)
}
