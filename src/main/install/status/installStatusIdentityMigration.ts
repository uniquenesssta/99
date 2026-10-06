import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import type { FontItem } from '../../../shared/types'
import { fileRuntimeFontId } from '../../fonts/fontFileIdentity'
import { normalizePathForCacheCompare } from '../../path/cachePath'

type IndexRow = { root_path: string; relative_path: string; file_size: number; modified_at: number; font_json: string }
const hash = (value: string) => createHash('sha1').update(value).digest('hex')
export type InstallIdentityMigrationReport = {
  migrated: number; unresolved: number; noIdentityCandidate: number;
  signatureMismatch: number; ambiguous: number; invalidCandidates: number; invalidSamples: Array<{ row: number; reason: string }>;
}
function signature(font: FontItem, id: string): string {
  return hash([id, normalizePathForCacheCompare(font.path), font.fileName || '', Math.round(font.fileSize || 0), Math.round(font.modifiedAt || 0), font.managedInstallPath || '', font.managedRegistryName || ''].join('|'))
}

// Keep original rows for older readers. The receipt stores the exact original and
// prevents deletion of a migrated runtime row from resurrecting its predecessor.
function installIdentityCandidates(rows: IndexRow[]) {
  const candidates = new Map<string, Map<string, FontItem>>()
  const legacyIds = new Set<string>()
  const invalidSamples: Array<{ row: number; reason: string }> = []
  let invalidCandidates = 0
  for (const [index, row] of rows.entries()) {
    try {
    const source = JSON.parse(row.font_json) as FontItem
    const path = win32.isAbsolute(row.relative_path) ? row.relative_path : win32.join(row.root_path, row.relative_path)
    const font = { ...source, path, fileName: win32.basename(path), fileSize: row.file_size, modifiedAt: row.modified_at }
    font.id = fileRuntimeFontId(path, row.file_size, row.modified_at)
    const legacy = (value: string) => hash(`${value.toLowerCase()}|${row.file_size}|${Math.round(row.modified_at)}`)
    for (const id of new Set([source.id, source.sourceId, legacy(row.relative_path), legacy(path)].filter(Boolean) as string[])) {
      if (id === font.id) continue
      legacyIds.add(id)
      const variants = [font]
      // A historical display filename may differ from the path basename. Accept
      // its exact signature only when path, size and mtime prove the same file.
      if (normalizePathForCacheCompare(source.path || '') === normalizePathForCacheCompare(path)
        && Math.round(source.fileSize || 0) === Math.round(row.file_size)
        && Math.round(source.modifiedAt || 0) === Math.round(row.modified_at)) variants.push({ ...source, id: font.id, path })
      for (const variant of variants) {
        const key = `${id}|${signature(variant, id)}`
        if (!candidates.has(key)) candidates.set(key, new Map())
        candidates.get(key)!.set(font.id, font)
      }
    }
    } catch (error) {
      invalidCandidates++
      if (invalidSamples.length < 3) invalidSamples.push({ row: index, reason: (error instanceof Error ? error.message : String(error)).slice(0, 160) })
    }
  }
  return { candidates, legacyIds, invalidCandidates, invalidSamples }
}

// Ignore unrelated index timestamps/labels. A retry is needed only when the
// identity candidates or the installation database have actually changed.
export function installIdentitySnapshotKey(rows: IndexRow[]): string {
  const { candidates } = installIdentityCandidates(rows)
  return hash([...candidates].map(([key, fonts]) => `${key}:${[...fonts.keys()].sort().join(',')}`).sort().join('\n'))
}

export function migrateInstallStatusIdentity(db: any, rows: IndexRow[], report?: (value: InstallIdentityMigrationReport) => void): number {
  db.prepare(`CREATE TABLE IF NOT EXISTS install_identity_migrations (
    legacy_id TEXT NOT NULL, signature TEXT NOT NULL, runtime_id TEXT NOT NULL, payload_json TEXT NOT NULL,
    PRIMARY KEY(legacy_id, signature)
  )`).run()
  const { candidates, legacyIds, invalidCandidates, invalidSamples } = installIdentityCandidates(rows)
  const result = db.transaction(() => {
    let migrated = 0
    const summary: InstallIdentityMigrationReport = { migrated: 0, unresolved: 0, noIdentityCandidate: 0, signatureMismatch: 0, ambiguous: 0, invalidCandidates, invalidSamples }
    const receipt = db.prepare('SELECT 1 FROM install_identity_migrations WHERE legacy_id=? AND signature=?')
    const saveReceipt = db.prepare('INSERT INTO install_identity_migrations VALUES (?,?,?,?)')
    const insert = db.prepare('INSERT OR IGNORE INTO install_status(font_id,signature,installed,by_type,matches_json,checked_at,system_default) VALUES (?,?,?,?,?,?,?)')
    const select = db.prepare('SELECT * FROM install_status WHERE font_id=?')
    const legacyRows = report
      ? db.prepare("SELECT * FROM install_status WHERE font_id NOT LIKE 'file-v2:%'").all()
      : [...legacyIds].map(id => select.get(id)).filter(Boolean)
    for (const row of legacyRows) {
      if (receipt.get(row.font_id, row.signature)) continue
      const matches = candidates.get(`${row.font_id}|${row.signature}`)
      if (matches?.size !== 1) {
        summary.unresolved += 1
        if (!legacyIds.has(row.font_id)) summary.noIdentityCandidate += 1
        else if (!matches?.size) summary.signatureMismatch += 1
        else summary.ambiguous += 1
        continue
      }
      const font = [...matches.values()][0]
      insert.run(font.id, signature(font, font.id), row.installed, row.by_type, row.matches_json, row.checked_at, row.system_default || 0)
      saveReceipt.run(row.font_id, row.signature, font.id, JSON.stringify(row))
      migrated += 1
    }
    if (migrated) db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES ('updatedAt',?)").run(new Date().toISOString())
    summary.migrated = migrated
    return summary
  })()
  report?.(result)
  return result.migrated
}
