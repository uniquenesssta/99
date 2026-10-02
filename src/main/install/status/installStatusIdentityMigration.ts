import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import type { FontItem } from '../../../shared/types'
import { fileRuntimeFontId } from '../../fonts/fontFileIdentity'
import { normalizePathForCacheCompare } from '../../path/cachePath'

type IndexRow = { root_path: string; relative_path: string; file_size: number; modified_at: number; font_json: string }
const hash = (value: string) => createHash('sha1').update(value).digest('hex')
function signature(font: FontItem, id: string): string {
  return hash([id, normalizePathForCacheCompare(font.path), font.fileName || '', Math.round(font.fileSize || 0), Math.round(font.modifiedAt || 0), font.managedInstallPath || '', font.managedRegistryName || ''].join('|'))
}

// Keep original rows for older readers. The receipt stores the exact original and
// prevents deletion of a migrated runtime row from resurrecting its predecessor.
export function migrateInstallStatusIdentity(db: any, rows: IndexRow[]): number {
  db.prepare(`CREATE TABLE IF NOT EXISTS install_identity_migrations (
    legacy_id TEXT NOT NULL, signature TEXT NOT NULL, runtime_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY(legacy_id, signature)
  )`).run()
  const candidates = new Map<string, Map<string, FontItem>>()
  const legacyIds = new Set<string>()
  for (const row of rows) {
    const source = JSON.parse(row.font_json) as FontItem
    const path = win32.isAbsolute(row.relative_path) ? row.relative_path : win32.join(row.root_path, row.relative_path)
    const font = { ...source, path, fileName: win32.basename(path), fileSize: row.file_size, modifiedAt: row.modified_at }
    font.id = fileRuntimeFontId(path, row.file_size, row.modified_at)
    const legacy = (value: string) => hash(`${value.toLowerCase()}|${row.file_size}|${Math.round(row.modified_at)}`)
    for (const id of new Set([source.id, source.sourceId, legacy(row.relative_path), legacy(path)].filter(Boolean) as string[])) {
      if (id === font.id) continue
      legacyIds.add(id)
      const key = `${id}|${signature(font, id)}`
      if (!candidates.has(key)) candidates.set(key, new Map())
      candidates.get(key)!.set(font.id, font)
    }
  }
  return db.transaction(() => {
    let migrated = 0
    const receipt = db.prepare('SELECT 1 FROM install_identity_migrations WHERE legacy_id=? AND signature=?')
    const saveReceipt = db.prepare('INSERT INTO install_identity_migrations VALUES (?,?,?,?)')
    const insert = db.prepare('INSERT OR IGNORE INTO install_status(font_id,signature,installed,by_type,matches_json,checked_at,system_default) VALUES (?,?,?,?,?,?,?)')
    const select = db.prepare('SELECT * FROM install_status WHERE font_id=?')
    for (const id of legacyIds) {
      const row = select.get(id)
      if (!row || receipt.get(row.font_id, row.signature)) continue
      const matches = candidates.get(`${row.font_id}|${row.signature}`)
      if (matches?.size !== 1) continue
      const font = [...matches.values()][0]
      insert.run(font.id, signature(font, font.id), row.installed, row.by_type, row.matches_json, row.checked_at, row.system_default || 0)
      saveReceipt.run(row.font_id, row.signature, font.id, JSON.stringify(row))
      migrated += 1
    }
    if (migrated) db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('updatedAt',?)").run(new Date().toISOString())
    return migrated
  })()
}
