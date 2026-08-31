import { parseTagNames } from './sharedMetadataStateRuntime'

export type SharedMetadataMigrationDiagnosticsReport = {
  ok: boolean
  rootPath: string
  schemaVersion: string
  requiredTablesMissing: string[]
  requiredColumnsMissing: string[]
  metadataRows: number
  rowsWithState: number
  rowsWithTags: number
  invalidTagJsonRows: number
  tagPairs: number
  missingTagOps: number
  legacyImportAt: string
  tagOpsBackfillAt: string
  replayMaxRowId: string
  severity: 'ok' | 'info' | 'warning' | 'critical'
  suggestedActions: string[]
}

export interface SharedMetadataMigrationDiagnosticsRuntimeDeps {
  readMeta: (db: any, key: string) => string
}

const REQUIRED_TABLES = ['meta', 'font_metadata', 'metadata_events', 'shared_tag_ops']
const REQUIRED_COLUMNS: Record<string, string[]> = {
  font_metadata: ['font_id', 'relative_path', 'path_key', 'tag_names_json', 'favorite', 'delete_protected', 'revision', 'updated_at', 'updated_by'],
  shared_tag_ops: ['op_id', 'font_id', 'relative_path', 'path_key', 'action', 'tag_name', 'base_revision', 'next_revision', 'created_at', 'machine_id', 'writer_pid', 'tombstone'],
}

function tableExists(db: any, tableName: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?`).get(tableName) as { count?: number } | undefined
  return Number(row?.count || 0) > 0
}

function columnNames(db: any, tableName: string): Set<string> {
  if (!tableExists(db, tableName)) return new Set()
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>
  return new Set(rows.map((row) => String(row.name || '')).filter(Boolean))
}

function safeJsonArray(value: unknown): { ok: boolean; tags: string[] } {
  const text = String(value || '')
  if (!text) return { ok: true, tags: [] }
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return { ok: false, tags: [] }
    return { ok: true, tags: parseTagNames(text) }
  } catch {
    return { ok: false, tags: [] }
  }
}

function stringValue(value: unknown): string {
  return String(value || '').trim()
}

export function createSharedMetadataMigrationDiagnosticsRuntime(deps: SharedMetadataMigrationDiagnosticsRuntimeDeps) {
  function readSharedMetadataMigrationDiagnosticsInOpenDb(db: any, rootPath: string): SharedMetadataMigrationDiagnosticsReport {
    const requiredTablesMissing = REQUIRED_TABLES.filter((tableName) => !tableExists(db, tableName))
    const requiredColumnsMissing: string[] = []
    for (const [tableName, columns] of Object.entries(REQUIRED_COLUMNS)) {
      const names = columnNames(db, tableName)
      for (const column of columns) {
        if (!names.has(column)) requiredColumnsMissing.push(`${tableName}.${column}`)
      }
    }

    let metadataRows = 0
    let rowsWithState = 0
    let rowsWithTags = 0
    let invalidTagJsonRows = 0
    let tagPairs = 0
    let missingTagOps = 0
    const existingOps = new Set<string>()

    if (tableExists(db, 'shared_tag_ops')) {
      const opRows = db.prepare('SELECT font_id, tag_name FROM shared_tag_ops').all() as Array<{ font_id?: string | null; tag_name?: string | null }>
      for (const row of opRows) {
        const fontId = stringValue(row.font_id)
        const tagName = stringValue(row.tag_name)
        if (fontId && tagName) existingOps.add(`${fontId}\u0000${tagName}`)
      }
    }

    if (tableExists(db, 'font_metadata')) {
      const rows = db.prepare('SELECT font_id, tag_names_json, favorite, delete_protected FROM font_metadata').all() as Array<{
        font_id?: string | null
        tag_names_json?: string | null
        favorite?: number | null
        delete_protected?: number | null
      }>
      metadataRows = rows.length
      for (const row of rows) {
        const parsed = safeJsonArray(row.tag_names_json)
        if (!parsed.ok) invalidTagJsonRows += 1
        const hasState = parsed.tags.length > 0 || Number(row.favorite || 0) > 0 || Number(row.delete_protected || 0) > 0
        if (hasState) rowsWithState += 1
        if (parsed.tags.length) rowsWithTags += 1
        const fontId = stringValue(row.font_id)
        for (const tagName of parsed.tags) {
          tagPairs += 1
          if (fontId && !existingOps.has(`${fontId}\u0000${tagName}`)) missingTagOps += 1
        }
      }
    }

    const schemaVersion = deps.readMeta(db, 'schemaVersion')
    const legacyImportAt = deps.readMeta(db, 'legacyRootIndexMetadataImportedAt')
    const tagOpsBackfillAt = deps.readMeta(db, 'sharedTagOpsBackfillAt')
    const replayMaxRowId = deps.readMeta(db, 'sharedTagOpsReplayMaxRowId')
    const suggestedActions: string[] = []
    if (requiredTablesMissing.length || requiredColumnsMissing.length) suggestedActions.push('reopen shared metadata database to run schema initialization before reading shared tags')
    if (schemaVersion && Number(schemaVersion) < 3) suggestedActions.push('upgrade shared metadata schema to version 3 for shared_tag_ops support')
    if (invalidTagJsonRows) suggestedActions.push('repair invalid font_metadata.tag_names_json rows before replaying shared tag operations')
    if (missingTagOps) suggestedActions.push('run shared tag ops legacy backfill so existing shared tags become replayable operations')
    if (!legacyImportAt && rowsWithState > 0) suggestedActions.push('verify legacy root-index metadata import marker; rows exist but import timestamp is missing')
    if (!suggestedActions.length) suggestedActions.push('no migration action required')

    let severity: SharedMetadataMigrationDiagnosticsReport['severity'] = 'ok'
    if (requiredTablesMissing.length || requiredColumnsMissing.length || invalidTagJsonRows) severity = 'critical'
    else if (missingTagOps) severity = 'warning'
    else if (!legacyImportAt && rowsWithState > 0) severity = 'info'

    return {
      ok: severity !== 'critical',
      rootPath,
      schemaVersion,
      requiredTablesMissing,
      requiredColumnsMissing,
      metadataRows,
      rowsWithState,
      rowsWithTags,
      invalidTagJsonRows,
      tagPairs,
      missingTagOps,
      legacyImportAt,
      tagOpsBackfillAt,
      replayMaxRowId,
      severity,
      suggestedActions,
    }
  }

  return {
    readSharedMetadataMigrationDiagnosticsInOpenDb,
  }
}
