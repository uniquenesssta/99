import { sanitizeStringArray, type FontQuerySqlParts } from '../query-sql/fontQuerySqlTypes'

export const LEGACY_COLLECTION_IDS_JSON_COLUMN = 'fonts.collection_ids_json'

export function isLegacyCollectionColumn(column: string): boolean {
  return column === LEGACY_COLLECTION_IDS_JSON_COLUMN
}

export function addLegacyCollectionContainsClause(parts: FontQuerySqlParts, value: string): boolean {
  if (!value) return true
  parts.clauses.push(
    'EXISTS (SELECT 1 FROM font_collections fc WHERE fc.font_id = fonts.id AND fc.collection_id = ?)',
  )
  parts.params.push(value)
  return true
}

export function addLegacyCollectionAnyClause(parts: FontQuerySqlParts, values: string[]): boolean {
  const cleanValues = sanitizeStringArray(values)
  if (!cleanValues.length) return true
  parts.clauses.push(
    `EXISTS (SELECT 1 FROM font_collections fc WHERE fc.font_id = fonts.id AND fc.collection_id IN (${cleanValues.map(() => '?').join(', ')}))`,
  )
  parts.params.push(...cleanValues)
  return true
}
