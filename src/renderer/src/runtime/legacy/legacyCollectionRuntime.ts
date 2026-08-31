import type { FontItem,LibraryState } from '@shared/types'
import { legacyCollectionIdsForFont as sharedLegacyCollectionIdsForFont } from '@shared/legacy/legacyCollectionCompatibility'
import type { ActiveFilter } from '../../appTypes'

export function legacyCollectionIdsForFont(font: FontItem): string[] {
  return sharedLegacyCollectionIdsForFont(font)
}

export function legacyCollectionMatchesFilter(filter: ActiveFilter, font: FontItem): boolean {
  return !!filter.id && legacyCollectionIdsForFont(font).includes(filter.id)
}

export function createLegacyCollectionCounts(library: LibraryState): Record<string, number> {
  const collectionCounts: Record<string, number> = {}
  for (const collection of library.collections || []) collectionCounts[collection.id] = 0
  return collectionCounts
}

export function addLegacyCollectionCounts(collectionCounts: Record<string, number>, font: FontItem): void {
  for (const id of legacyCollectionIdsForFont(font)) {
    collectionCounts[id] = (collectionCounts[id] || 0) + 1
  }
}
