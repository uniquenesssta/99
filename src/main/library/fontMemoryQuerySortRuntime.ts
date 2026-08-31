import type { FontItem,FontQueryRequest } from '../../shared/types'

export function compareSharedFonts(
  a: FontItem,
  b: FontItem,
  request: FontQueryRequest,
): number {
  const sortMode = request.sortMode || 'smart'
  const timeSortMode = request.timeSortMode || 'created'
  const nameCmp =
    a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' }) ||
    a.id.localeCompare(b.id)
  if (sortMode === 'nameAsc') return nameCmp
  if (sortMode === 'nameDesc') return -nameCmp
  if (sortMode === 'createdDesc')
    return Number(b.createdAt || 0) - Number(a.createdAt || 0) || nameCmp
  if (sortMode === 'createdAsc')
    return Number(a.createdAt || 0) - Number(b.createdAt || 0) || nameCmp
  if (sortMode === 'modifiedDesc')
    return Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0) || nameCmp
  if (sortMode === 'modifiedAsc')
    return Number(a.modifiedAt || 0) - Number(b.modifiedAt || 0) || nameCmp
  if (sortMode === 'sizeDesc')
    return Number(b.fileSize || 0) - Number(a.fileSize || 0) || nameCmp
  if (sortMode === 'sizeAsc')
    return Number(a.fileSize || 0) - Number(b.fileSize || 0) || nameCmp
  const installedCmp = Number(!!b.systemInstalled) - Number(!!a.systemInstalled)
  const favoriteCmp = Number(!!b.favorite) - Number(!!a.favorite)
  const activeCmp = Number(!!b.active) - Number(!!a.active)
  const timeCmp =
    timeSortMode === 'created'
      ? Number(b.createdAt || 0) - Number(a.createdAt || 0)
      : Number(b.modifiedAt || 0) - Number(a.modifiedAt || 0)
  return favoriteCmp || activeCmp || installedCmp || timeCmp || nameCmp
}
