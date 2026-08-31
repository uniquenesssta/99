import type { FontCollection, FontItem } from '../types'

export const LEGACY_COLLECTION_EMPTY_FIELDS = {
  collections: [] as FontCollection[],
  localCollections: [] as FontCollection[],
}

export function normalizeLegacyCollectionIds(value: unknown): string[] {
  return Array.isArray(value) ? (value as string[]) : []
}

export function legacyCollectionIdsForFont(font: Partial<Pick<FontItem, 'collectionIds'>> | null | undefined): string[] {
  return normalizeLegacyCollectionIds(font?.collectionIds)
}

export function normalizeLegacyCollections(value: unknown): FontCollection[] {
  return Array.isArray(value) ? (value as FontCollection[]) : []
}

export function createLegacyCollectionStateFields(source?: { collections?: unknown; localCollections?: unknown }): typeof LEGACY_COLLECTION_EMPTY_FIELDS {
  return {
    collections: normalizeLegacyCollections(source?.collections),
    localCollections: normalizeLegacyCollections(source?.localCollections),
  }
}
