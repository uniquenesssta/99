import type { FontItem } from '../../../shared/types'
import { legacyCollectionIdsForFont as sharedLegacyCollectionIdsForFont } from '../../../shared/legacy/legacyCollectionCompatibility'
import { parseSqliteJson,sqliteTableExists } from '../../db/sqliteHelpers'

export function legacyCollectionIdsForFont(font: FontItem): string[] {
  return sharedLegacyCollectionIdsForFont(font)
}

export function legacyCollectionSearchTextForFont(font: FontItem, collectionNameById?: Map<string, string>): string {
  return legacyCollectionIdsForFont(font)
    .map((id) => collectionNameById?.get(id) || '')
    .filter(Boolean)
    .join(' ')
}

export function loadLegacyCollectionNameMap(db: any): Map<string, string> {
  const collectionNameById = new Map<string, string>()
  if (!sqliteTableExists(db, 'collections')) return collectionNameById
  for (const row of db.prepare('SELECT id, json FROM collections').all() as Array<{ id: string; json: string }>) {
    const collection = parseSqliteJson<{ name?: string }>(row.json, {})
    if (collection.name) collectionNameById.set(row.id, collection.name)
  }
  return collectionNameById
}
