import type { SortMode } from '../../appTypes'

export type NameSortCycleState = 'default' | 'asc' | 'desc'

export function nameSortCycleState(sortMode: SortMode): NameSortCycleState {
  if (sortMode === 'nameAsc') return 'asc'
  if (sortMode === 'nameDesc') return 'desc'
  return 'default'
}

export function nextNameSortMode(sortMode: SortMode): SortMode {
  const state = nameSortCycleState(sortMode)
  if (state === 'default') return 'nameAsc'
  if (state === 'asc') return 'nameDesc'
  return 'smart'
}

export function nameSortCycleIcon(sortMode: SortMode): string {
  const state = nameSortCycleState(sortMode)
  if (state === 'asc') return 'A↓'
  if (state === 'desc') return 'Z↓'
  return 'A↕'
}

export function nameSortCycleTooltip(sortMode: SortMode): string {
  const state = nameSortCycleState(sortMode)
  if (state === 'asc') return '名称排序：正序 A-Z，点击切换 Z-A'
  if (state === 'desc') return '名称排序：倒序 Z-A，点击恢复智能排序'
  return '名称排序：智能排序，点击切换 A-Z'
}
