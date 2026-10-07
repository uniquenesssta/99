import { basename } from 'node:path'
import type { FontFormat,FontItem,FontScript,SystemInstalledFont } from '../../shared/types'
import {
parseSqliteJson,
setSqliteMeta,
sqlBool,
sqlJson,
sqlNullableNumber,
sqlNullableText,
sqlNumber,
sqlText
} from '../db/sqliteHelpers'

export function normalizeFontFormat(value: unknown): FontFormat {
  return value === 'ttf' || value === 'otf' || value === 'ttc' || value === 'otc' ? value : 'unknown'
}

export function fontToSqliteParams(id: string, font: FontItem, now: string): Record<string, unknown> {
  const normalizedFont: FontItem = {
    ...font,
    id: font.id || id,
    fileName: font.fileName || basename(font.path || ''),
    family: font.family || '',
    fullName: font.fullName || font.family || font.fileName || '',
    postscriptName: font.postscriptName || '',
    style: font.style || '',
    format: normalizeFontFormat(font.format),
    scripts: Array.isArray(font.scripts) ? font.scripts : [],
    collectionIds: Array.isArray(font.collectionIds) ? font.collectionIds : [],
    tagNames: Array.isArray(font.tagNames) ? font.tagNames : [],
    localTagNames: Array.isArray(font.localTagNames) ? font.localTagNames : [],
    systemInstallMatches: Array.isArray(font.systemInstallMatches) ? font.systemInstallMatches : [],
    systemInstalled: !!font.systemInstalled,
    active: !!font.active,
    favorite: !!font.favorite,
    systemImported: !!font.systemImported,
    previewDisabled: !!font.previewDisabled,
    deleteProtected: !!font.deleteProtected
  }

  return {
    id: normalizedFont.id,
    path: normalizedFont.path || '',
    file_name: normalizedFont.fileName || '',
    family: normalizedFont.family || '',
    full_name: normalizedFont.fullName || '',
    postscript_name: normalizedFont.postscriptName || '',
    style: normalizedFont.style || '',
    format: normalizedFont.format || 'unknown',
    scripts_json: sqlJson(normalizedFont.scripts || [], []),
    script_version: sqlNumber(normalizedFont.scriptVersion, 0),
    file_size: sqlNumber(normalizedFont.fileSize, 0),
    modified_at: sqlNumber(normalizedFont.modifiedAt, 0),
    created_at: sqlNullableNumber(normalizedFont.createdAt),
    added_at: normalizedFont.addedAt || now,
    favorite: sqlBool(normalizedFont.favorite),
    collection_ids_json: sqlJson(normalizedFont.collectionIds || [], []),
    tag_names_json: sqlJson(normalizedFont.tagNames || [], []),
    system_installed: sqlBool(normalizedFont.systemInstalled),
    system_install_matches_json: sqlJson(normalizedFont.systemInstallMatches || [], []),
    active: sqlBool(normalizedFont.active),
    system_imported: sqlBool(normalizedFont.systemImported),
    preview_disabled: sqlBool(normalizedFont.previewDisabled),
    preview_error: sqlNullableText(normalizedFont.previewError),
    active_since: sqlNullableText(normalizedFont.activeSince),
    managed_install_path: sqlNullableText(normalizedFont.managedInstallPath),
    managed_registry_name: sqlNullableText(normalizedFont.managedRegistryName),
    delete_protected: sqlBool(normalizedFont.deleteProtected),
    json: sqlJson(normalizedFont, {}),
    updated_at: now
  }
}

export function fontFromSqliteRow(row: Record<string, unknown>): FontItem {
  const fallback = parseSqliteJson<Partial<FontItem>>(row.detail_json ?? row.json, {})
  const id = sqlText(row.id) || fallback.id || ''
  const pathValue = sqlText(row.path) || fallback.path || ''
  const fileName = sqlText(row.file_name) || fallback.fileName || basename(pathValue)
  const installStatusValue = row.installed
  const hasInstallStatusRow = installStatusValue !== null && installStatusValue !== undefined

  return {
    ...fallback,
    id,
    path: pathValue,
    fileName,
    family: sqlText(row.family) || fallback.family || '',
    fullName: sqlText(row.full_name) || fallback.fullName || fallback.family || fileName,
    postscriptName: sqlText(row.postscript_name) || fallback.postscriptName || '',
    style: sqlText(row.style) || fallback.style || '',
    format: normalizeFontFormat(row.format || fallback.format),
    scripts: parseSqliteJson<FontScript[]>(row.scripts_json, Array.isArray(fallback.scripts) ? fallback.scripts : []),
    scriptVersion: sqlNumber(row.script_version, fallback.scriptVersion || 0),
    fileSize: sqlNumber(row.file_size, fallback.fileSize || 0),
    modifiedAt: sqlNumber(row.modified_at, fallback.modifiedAt || 0),
    createdAt: row.created_at === null || row.created_at === undefined ? fallback.createdAt : sqlNumber(row.created_at, fallback.createdAt || 0),
    addedAt: sqlText(row.added_at) || fallback.addedAt || new Date(0).toISOString(),
    favorite: !!row.favorite,
    collectionIds: parseSqliteJson<string[]>(row.collection_ids_json, Array.isArray(fallback.collectionIds) ? fallback.collectionIds : []),
    tagNames: parseSqliteJson<string[]>(row.tag_names_json, Array.isArray(fallback.tagNames) ? fallback.tagNames : []),
    installStatusKnown: hasInstallStatusRow || !!row.system_installed || !!fallback.installStatusKnown,
    systemInstalled: hasInstallStatusRow ? !!installStatusValue : !!row.system_installed,
    systemInstallMatches: parseSqliteJson<SystemInstalledFont[]>(row.system_install_matches_json, Array.isArray(fallback.systemInstallMatches) ? fallback.systemInstallMatches : []),
    active: !!row.active,
    systemImported: !!row.system_imported,
    previewDisabled: !!row.preview_disabled,
    previewError: sqlText(row.preview_error) || fallback.previewError,
    activeSince: sqlText(row.active_since) || fallback.activeSince,
    managedInstallPath: sqlText(row.managed_install_path) || fallback.managedInstallPath,
    managedRegistryName: sqlText(row.managed_registry_name) || fallback.managedRegistryName,
    deleteProtected: !!row.delete_protected
  }
}

export function fontListSelectColumns(alias = 'fonts'): string {
  const a = alias
  return [
    `${a}.id`, `${a}.path`, `${a}.file_name`, `${a}.family`, `${a}.full_name`, `${a}.postscript_name`, `${a}.style`, `${a}.format`,
    `${a}.scripts_json`, `${a}.script_version`, `${a}.file_size`, `${a}.modified_at`, `${a}.created_at`, `${a}.added_at`,
    `${a}.favorite`, `${a}.collection_ids_json`, `${a}.tag_names_json`, `${a}.system_installed`, `${a}.system_install_matches_json`,
    `${a}.active`, `${a}.system_imported`, `${a}.preview_disabled`, `${a}.preview_error`, `${a}.active_since`,
    `${a}.managed_install_path`, `${a}.managed_registry_name`, `${a}.delete_protected`, `${a}.updated_at`, `${a}.deleted_at`,
    `font_details.json AS detail_json`
  ].join(', ')
}

export function syncFontDetailsAndRelations(db: any, font: FontItem, now: string): void {
  const fontId = font.id
  if (!fontId) return

  db.prepare(`
    INSERT INTO font_details (font_id, json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(font_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(fontId, JSON.stringify(font), now)

  db.prepare('DELETE FROM font_scripts WHERE font_id = ?').run(fontId)
  db.prepare('DELETE FROM font_collections WHERE font_id = ?').run(fontId)
  db.prepare('DELETE FROM font_tags WHERE font_id = ?').run(fontId)

  const insertScript = db.prepare('INSERT OR IGNORE INTO font_scripts (font_id, script) VALUES (?, ?)')
  for (const script of Array.isArray(font.scripts) ? font.scripts : []) insertScript.run(fontId, script)

  const insertCollection = db.prepare('INSERT OR IGNORE INTO font_collections (font_id, collection_id) VALUES (?, ?)')
  for (const collectionId of Array.isArray(font.collectionIds) ? font.collectionIds : []) insertCollection.run(fontId, collectionId)

  const insertTag = db.prepare('INSERT OR IGNORE INTO font_tags (font_id, tag_name) VALUES (?, ?)')
  for (const tagName of Array.isArray(font.tagNames) ? font.tagNames : []) insertTag.run(fontId, tagName)
}

export function deleteFontRelationsAndDetails(db: any, fontId: string): void {
  db.prepare('DELETE FROM font_details WHERE font_id = ?').run(fontId)
  db.prepare('DELETE FROM font_scripts WHERE font_id = ?').run(fontId)
  db.prepare('DELETE FROM font_collections WHERE font_id = ?').run(fontId)
  db.prepare('DELETE FROM font_tags WHERE font_id = ?').run(fontId)
}

export function migrateFontRelationsFromJsonIfNeeded(db: any): void {
  const current = db.prepare('SELECT value FROM meta WHERE key = ?').get('fontRelationsMigrated') as { value?: string } | undefined
  if (current?.value === '1') return

  const rows = db.prepare(`SELECT ${fontListSelectColumns('fonts')} FROM fonts LEFT JOIN font_details ON font_details.font_id = fonts.id WHERE fonts.deleted_at IS NULL ORDER BY fonts.id`).all() as Array<Record<string, unknown>>
  const now = new Date().toISOString()
  const migrate = db.transaction(() => {
    for (const row of rows) {
      const font = fontFromSqliteRow(row)
      if (!font.id) continue
      syncFontDetailsAndRelations(db, font, now)
    }
    setSqliteMeta(db, 'fontRelationsMigrated', '1')
    setSqliteMeta(db, 'fontRelationsMigratedAt', now)
  })
  migrate()
}
