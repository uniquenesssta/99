import { addRootIndexJsonArrayContainsClause } from '../rootIndexQuerySharedSql'
import type { RootIndexQueryParts } from '../rootIndexQueryTypes'

export const LEGACY_COLLECTION_IDS_FIELD = 'collectionIds'

export function addLegacyRootIndexCollectionContainsClause(parts: RootIndexQueryParts, value: string): void {
  addRootIndexJsonArrayContainsClause(parts, LEGACY_COLLECTION_IDS_FIELD, value)
}
