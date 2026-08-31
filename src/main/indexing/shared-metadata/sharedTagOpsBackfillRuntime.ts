import { createHash } from 'node:crypto'
import { cleanTagNames, parseTagNames } from './sharedMetadataStateRuntime'

export type SharedTagOpsBackfillReport = {
  ok: boolean
  rootPath: string
  reason: string
  checkedRows: number
  tagPairs: number
  existingOps: number
  backfilledOps: number
  missingBeforeBackfill: number
  skipped: boolean
  updatedAt: string
}

export type SharedTagOpsBackfillDiagnosticsReport = {
  ok: boolean
  rootPath: string
  checkedRows: number
  tagPairs: number
  existingOps: number
  missingTagOps: number
  lastBackfilledAt: string
}

export interface SharedTagOpsBackfillRuntimeDeps {
  readMeta: (db: any, key: string) => string
  writeMeta: (db: any, key: string, value: string) => void
  appendStartupLog: (message: string) => void
}

type SharedMetadataTagRow = {
  font_id?: string | null
  relative_path?: string | null
  path_key?: string | null
  tag_names_json?: string | null
  revision?: number | null
  updated_at?: string | null
  updated_by?: string | null
}

const BACKFILL_AT_META_KEY = 'sharedTagOpsBackfillAt'
const BACKFILL_COUNT_META_KEY = 'sharedTagOpsBackfillCount'
const BACKFILL_SCHEMA_META_KEY = 'sharedTagOpsBackfillSchemaVersion'
const BACKFILL_SCHEMA_VERSION = '1'

function stringValue(value: unknown): string {
  return String(value || '').trim()
}

function numberValue(value: unknown): number {
  const number = Number(value || 0)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function tableExists(db: any, tableName: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?`).get(tableName) as { count?: number } | undefined
  return Number(row?.count || 0) > 0
}

function readMetadataRowsWithTags(db: any): SharedMetadataTagRow[] {
  if (!tableExists(db, 'font_metadata')) return []
  return db.prepare(`
    SELECT font_id, relative_path, path_key, tag_names_json, revision, updated_at, updated_by
    FROM font_metadata
  `).all() as SharedMetadataTagRow[]
}

function readExistingTagOpPairs(db: any): Set<string> {
  const existing = new Set<string>()
  if (!tableExists(db, 'shared_tag_ops')) return existing
  const rows = db.prepare(`
    SELECT font_id, tag_name
    FROM shared_tag_ops
    WHERE font_id IS NOT NULL AND tag_name IS NOT NULL
  `).all() as Array<{ font_id?: string | null; tag_name?: string | null }>
  for (const row of rows) {
    const fontId = stringValue(row.font_id)
    const tagName = stringValue(row.tag_name)
    if (fontId && tagName) existing.add(`${fontId}\u0000${tagName}`)
  }
  return existing
}

function deterministicBootstrapOpId(fontId: string, tagName: string): string {
  const digest = createHash('sha1').update(`${fontId}\u0000${tagName}`).digest('hex')
  return `legacy-bootstrap:${digest}`
}

function collectTagPairs(rows: SharedMetadataTagRow[], existingOps: Set<string>) {
  const pairs: Array<{ row: SharedMetadataTagRow; fontId: string; tagName: string }> = []
  let tagPairs = 0
  let existing = 0
  for (const row of rows) {
    const fontId = stringValue(row.font_id)
    if (!fontId) continue
    const tags = cleanTagNames(parseTagNames(row.tag_names_json))
    for (const tagName of tags) {
      tagPairs += 1
      const pairKey = `${fontId}\u0000${tagName}`
      if (existingOps.has(pairKey)) {
        existing += 1
      } else {
        pairs.push({ row, fontId, tagName })
      }
    }
  }
  return { tagPairs, existing, missing: pairs }
}

export function createSharedTagOpsBackfillRuntime(deps: SharedTagOpsBackfillRuntimeDeps) {
  function readSharedTagOpsBackfillDiagnosticsInOpenDb(db: any, rootPath: string): SharedTagOpsBackfillDiagnosticsReport {
    const rows = readMetadataRowsWithTags(db)
    const existingOps = readExistingTagOpPairs(db)
    const { tagPairs, existing, missing } = collectTagPairs(rows, existingOps)
    return {
      ok: true,
      rootPath,
      checkedRows: rows.length,
      tagPairs,
      existingOps: existing,
      missingTagOps: missing.length,
      lastBackfilledAt: deps.readMeta(db, BACKFILL_AT_META_KEY),
    }
  }

  function ensureSharedTagOpsBackfilledInOpenDb(db: any, rootPath: string, reason = 'read'): SharedTagOpsBackfillReport {
    const updatedAt = new Date().toISOString()
    if (!tableExists(db, 'font_metadata') || !tableExists(db, 'shared_tag_ops')) {
      return {
        ok: true,
        rootPath,
        reason,
        checkedRows: 0,
        tagPairs: 0,
        existingOps: 0,
        backfilledOps: 0,
        missingBeforeBackfill: 0,
        skipped: true,
        updatedAt,
      }
    }

    const rows = readMetadataRowsWithTags(db)
    const existingOps = readExistingTagOpPairs(db)
    const { tagPairs, existing, missing } = collectTagPairs(rows, existingOps)
    if (!missing.length) {
      deps.writeMeta(db, BACKFILL_SCHEMA_META_KEY, BACKFILL_SCHEMA_VERSION)
      return {
        ok: true,
        rootPath,
        reason,
        checkedRows: rows.length,
        tagPairs,
        existingOps: existing,
        backfilledOps: 0,
        missingBeforeBackfill: 0,
        skipped: true,
        updatedAt,
      }
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO shared_tag_ops (
        op_id, font_id, relative_path, path_key, action, tag_name, base_revision, next_revision, created_at, machine_id, writer_pid, tombstone
      ) VALUES (?, ?, ?, ?, 'addTag', ?, 0, ?, ?, ?, ?, 0)
    `)
    let written = 0
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const item of missing) {
        const row = item.row
        const nextRevision = Math.max(1, numberValue(row.revision))
        const createdAt = stringValue(row.updated_at) || updatedAt
        const machineId = stringValue(row.updated_by) || 'legacy-metadata-backfill'
        const result = insert.run(
          deterministicBootstrapOpId(item.fontId, item.tagName),
          item.fontId,
          stringValue(row.relative_path),
          stringValue(row.path_key),
          item.tagName,
          nextRevision,
          createdAt,
          machineId,
          process.pid,
        )
        written += Number(result?.changes || 0)
      }
      deps.writeMeta(db, BACKFILL_AT_META_KEY, updatedAt)
      deps.writeMeta(db, BACKFILL_COUNT_META_KEY, String(written))
      deps.writeMeta(db, BACKFILL_SCHEMA_META_KEY, BACKFILL_SCHEMA_VERSION)
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* ignore */ }
      throw error
    }

    if (written) {
      deps.appendStartupLog(`shared tag ops legacy backfill: root=${rootPath}, reason=${reason}, tagPairs=${tagPairs}, written=${written}`)
    }
    return {
      ok: true,
      rootPath,
      reason,
      checkedRows: rows.length,
      tagPairs,
      existingOps: existing,
      backfilledOps: written,
      missingBeforeBackfill: missing.length,
      skipped: false,
      updatedAt,
    }
  }

  return {
    ensureSharedTagOpsBackfilledInOpenDb,
    readSharedTagOpsBackfillDiagnosticsInOpenDb,
  }
}
