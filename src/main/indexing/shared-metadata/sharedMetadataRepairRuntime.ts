import os from 'node:os'
import { parseTagNames } from './sharedMetadataStateRuntime'

export type SharedMetadataRepairOptions = {
  dryRun?: boolean
  repairInvalidTagJson?: boolean
  purgeInvalidTagOps?: boolean
  archiveOrphanTagOps?: boolean
  purgeArchivedOrphanTagOps?: boolean
  orphanArchiveReason?: string
}

export type SharedMetadataRepairReport = {
  ok: boolean
  rootPath: string
  dryRun: boolean
  invalidTagJsonRows: number
  repairedInvalidTagJsonRows: number
  invalidTagOps: number
  purgedInvalidTagOps: number
  orphanTagOps: number
  archivedOrphanTagOps: number
  purgedOrphanTagOps: number
  orphanArchiveReason: string
  orphanArchiveTable: string
  warnings: string[]
  suggestedActions: string[]
  repairedAt: string
}

export interface SharedMetadataRepairRuntimeDeps {
  writeMeta: (db: any, key: string, value: string) => void
  appendStartupLog: (message: string) => void
}

const ORPHAN_ARCHIVE_TABLE = 'shared_tag_ops_archive'

function tableExists(db: any, tableName: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?`).get(tableName) as { count?: number } | undefined
  return Number(row?.count || 0) > 0
}

function safeTagJson(value: unknown): { ok: boolean; normalizedJson: string } {
  const text = String(value || '')
  if (!text) return { ok: true, normalizedJson: '[]' }
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return { ok: false, normalizedJson: '[]' }
    return { ok: true, normalizedJson: JSON.stringify(parseTagNames(text)) }
  } catch {
    return { ok: false, normalizedJson: '[]' }
  }
}

function ensureSharedTagOpsArchiveTable(db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS shared_tag_ops_archive (
      archive_id INTEGER PRIMARY KEY AUTOINCREMENT,
      archived_at TEXT NOT NULL,
      archive_reason TEXT NOT NULL,
      source_table TEXT NOT NULL DEFAULT 'shared_tag_ops',
      op_id TEXT NOT NULL,
      font_id TEXT,
      relative_path TEXT,
      path_key TEXT,
      action TEXT,
      tag_name TEXT,
      base_revision INTEGER,
      next_revision INTEGER,
      created_at TEXT,
      machine_id TEXT,
      writer_pid INTEGER,
      tombstone INTEGER,
      payload_json TEXT NOT NULL,
      UNIQUE(source_table, op_id, archive_reason)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_archive_op ON shared_tag_ops_archive(op_id);
    CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_archive_reason ON shared_tag_ops_archive(archive_reason, archived_at);
  `)
}

export function createSharedMetadataRepairRuntime(deps: SharedMetadataRepairRuntimeDeps) {
  function repairSharedMetadataInOpenDb(
    db: any,
    rootPath: string,
    options: SharedMetadataRepairOptions = {},
  ): SharedMetadataRepairReport {
    const dryRun = options.dryRun !== false
    const repairInvalidTagJson = options.repairInvalidTagJson !== false
    const purgeInvalidTagOps = options.purgeInvalidTagOps !== false
    const archiveOrphanTagOps = options.archiveOrphanTagOps === true
    const purgeArchivedOrphanTagOps = options.purgeArchivedOrphanTagOps === true
    const orphanArchiveReason = String(options.orphanArchiveReason || 'orphan-font-metadata').trim() || 'orphan-font-metadata'
    const repairedAt = new Date().toISOString()
    const warnings: string[] = []
    const suggestedActions: string[] = []
    let invalidTagJsonRows = 0
    let repairedInvalidTagJsonRows = 0
    let invalidTagOps = 0
    let purgedInvalidTagOps = 0
    let orphanTagOps = 0
    let archivedOrphanTagOps = 0
    let purgedOrphanTagOps = 0

    if (!tableExists(db, 'font_metadata')) {
      warnings.push('font_metadata table missing')
      suggestedActions.push('open shared metadata database through normal runtime to initialize schema before repair')
      return {
        ok: false,
        rootPath,
        dryRun,
        invalidTagJsonRows,
        repairedInvalidTagJsonRows,
        invalidTagOps,
        purgedInvalidTagOps,
        orphanTagOps,
        archivedOrphanTagOps,
        purgedOrphanTagOps,
        orphanArchiveReason,
        orphanArchiveTable: ORPHAN_ARCHIVE_TABLE,
        warnings,
        suggestedActions,
        repairedAt,
      }
    }

    const rows = db.prepare('SELECT font_id, tag_names_json, revision FROM font_metadata').all() as Array<{
      font_id?: string | null
      tag_names_json?: string | null
      revision?: number | null
    }>
    const invalidRows = rows
      .map((row) => ({ row, parsed: safeTagJson(row.tag_names_json) }))
      .filter((entry) => !entry.parsed.ok)
    invalidTagJsonRows = invalidRows.length

    if (!dryRun && repairInvalidTagJson && invalidRows.length) {
      db.exec('BEGIN IMMEDIATE')
      try {
        const update = db.prepare(`
          UPDATE font_metadata
          SET tag_names_json = ?, revision = COALESCE(revision, 0) + 1, updated_at = ?, updated_by = ?
          WHERE font_id = ?
        `)
        const eventInsert = tableExists(db, 'metadata_events')
          ? db.prepare(`
            INSERT INTO metadata_events (event_type, font_id, relative_path, payload_json, created_at, writer_host, writer_pid)
            VALUES (?, ?, NULL, ?, ?, ?, ?)
          `)
          : null
        for (const entry of invalidRows) {
          const fontId = String(entry.row.font_id || '')
          if (!fontId) continue
          update.run('[]', repairedAt, 'maintenance-repair', fontId)
          eventInsert?.run('repair_invalid_tag_json', fontId, JSON.stringify({ previousTagNamesJson: entry.row.tag_names_json || null, repairedTagNamesJson: '[]' }), repairedAt, os.hostname(), process.pid)
          repairedInvalidTagJsonRows += 1
        }
        deps.writeMeta(db, 'sharedMetadataRepairAt', repairedAt)
        deps.writeMeta(db, 'sharedMetadataRepairInvalidTagJsonRows', String(repairedInvalidTagJsonRows))
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* ignore */ }
        throw error
      }
    }

    if (tableExists(db, 'shared_tag_ops')) {
      const invalidOps = db.prepare(`
        SELECT op_id, font_id, tag_name, action FROM shared_tag_ops
        WHERE COALESCE(font_id, '') = ''
          OR COALESCE(tag_name, '') = ''
          OR action NOT IN ('addTag', 'removeTag')
      `).all() as Array<{ op_id?: string | null }>
      invalidTagOps = invalidOps.length

      const orphanRow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM shared_tag_ops ops
        LEFT JOIN font_metadata meta ON meta.font_id = ops.font_id
        WHERE meta.font_id IS NULL
      `).get() as { count?: number } | undefined
      orphanTagOps = Number(orphanRow?.count || 0)

      if (!dryRun && purgeInvalidTagOps && invalidOps.length) {
        db.exec('BEGIN IMMEDIATE')
        try {
          const deleteOp = db.prepare('DELETE FROM shared_tag_ops WHERE op_id = ?')
          for (const row of invalidOps) {
            const opId = String(row.op_id || '')
            if (!opId) continue
            purgedInvalidTagOps += Number(deleteOp.run(opId)?.changes || 0)
          }
          deps.writeMeta(db, 'sharedMetadataRepairInvalidTagOpsPurgedAt', repairedAt)
          deps.writeMeta(db, 'sharedMetadataRepairInvalidTagOpsPurged', String(purgedInvalidTagOps))
          db.exec('COMMIT')
        } catch (error) {
          try { db.exec('ROLLBACK') } catch { /* ignore */ }
          throw error
        }
      }

      if (!dryRun && archiveOrphanTagOps && orphanTagOps > 0) {
        db.exec('BEGIN IMMEDIATE')
        try {
          ensureSharedTagOpsArchiveTable(db)
          const archived = db.prepare(`
            INSERT OR IGNORE INTO shared_tag_ops_archive (
              archived_at,
              archive_reason,
              source_table,
              op_id,
              font_id,
              relative_path,
              path_key,
              action,
              tag_name,
              base_revision,
              next_revision,
              created_at,
              machine_id,
              writer_pid,
              tombstone,
              payload_json
            )
            SELECT
              ?,
              ?,
              'shared_tag_ops',
              ops.op_id,
              ops.font_id,
              ops.relative_path,
              ops.path_key,
              ops.action,
              ops.tag_name,
              ops.base_revision,
              ops.next_revision,
              ops.created_at,
              ops.machine_id,
              ops.writer_pid,
              ops.tombstone,
              json_object(
                'op_id', ops.op_id,
                'font_id', ops.font_id,
                'relative_path', ops.relative_path,
                'path_key', ops.path_key,
                'action', ops.action,
                'tag_name', ops.tag_name,
                'base_revision', ops.base_revision,
                'next_revision', ops.next_revision,
                'created_at', ops.created_at,
                'machine_id', ops.machine_id,
                'writer_pid', ops.writer_pid,
                'tombstone', ops.tombstone
              )
            FROM shared_tag_ops ops
            LEFT JOIN font_metadata meta ON meta.font_id = ops.font_id
            WHERE meta.font_id IS NULL
          `).run(repairedAt, orphanArchiveReason)
          archivedOrphanTagOps = Number(archived?.changes || 0)
          if (purgeArchivedOrphanTagOps) {
            const purged = db.prepare(`
              DELETE FROM shared_tag_ops
              WHERE op_id IN (
                SELECT archive.op_id
                FROM shared_tag_ops_archive archive
                WHERE archive.source_table = 'shared_tag_ops'
                  AND archive.archive_reason = ?
              )
                AND font_id NOT IN (SELECT font_id FROM font_metadata)
            `).run(orphanArchiveReason)
            purgedOrphanTagOps = Number(purged?.changes || 0)
          }
          deps.writeMeta(db, 'sharedTagOpsOrphanArchiveAt', repairedAt)
          deps.writeMeta(db, 'sharedTagOpsOrphanArchiveReason', orphanArchiveReason)
          deps.writeMeta(db, 'sharedTagOpsOrphanArchived', String(archivedOrphanTagOps))
          deps.writeMeta(db, 'sharedTagOpsOrphanPurged', String(purgedOrphanTagOps))
          db.exec('COMMIT')
        } catch (error) {
          try { db.exec('ROLLBACK') } catch { /* ignore */ }
          throw error
        }
      }
    }

    if (invalidTagJsonRows && dryRun) suggestedActions.push('run shared metadata repair with apply=true to reset invalid tag JSON rows to []')
    if (invalidTagOps && dryRun) suggestedActions.push('run shared metadata repair with apply=true to purge invalid shared_tag_ops rows')
    if (orphanTagOps && dryRun) suggestedActions.push('run shared metadata repair with apply=true and archiveOrphanTagOps=true after confirming the fonts were intentionally removed')
    if (orphanTagOps && !dryRun && !archiveOrphanTagOps) suggestedActions.push('orphan shared_tag_ops remain untouched; rerun with archiveOrphanTagOps=true if they should be archived')
    if (archiveOrphanTagOps && !purgeArchivedOrphanTagOps && archivedOrphanTagOps) suggestedActions.push('orphan shared_tag_ops were archived but left in place; rerun with purgeArchivedOrphanTagOps=true to remove archived rows')
    if (!suggestedActions.length) suggestedActions.push('no shared metadata repair action required')
    if (invalidTagJsonRows) warnings.push(`invalid font_metadata.tag_names_json rows=${invalidTagJsonRows}`)
    if (invalidTagOps) warnings.push(`invalid shared_tag_ops rows=${invalidTagOps}`)
    if (orphanTagOps) warnings.push(`orphan shared_tag_ops rows=${orphanTagOps}`)

    const ok = invalidTagJsonRows === 0 && invalidTagOps === 0 && (orphanTagOps === 0 || archivedOrphanTagOps > 0 || !archiveOrphanTagOps)
    deps.appendStartupLog(`shared metadata repair ${dryRun ? 'dry-run' : 'apply'}: root=${rootPath}, invalidTagJsonRows=${invalidTagJsonRows}, repaired=${repairedInvalidTagJsonRows}, invalidTagOps=${invalidTagOps}, purged=${purgedInvalidTagOps}, orphanTagOps=${orphanTagOps}, archivedOrphans=${archivedOrphanTagOps}, purgedOrphans=${purgedOrphanTagOps}`)
    return {
      ok: dryRun ? ok : repairedInvalidTagJsonRows === invalidTagJsonRows && purgedInvalidTagOps === invalidTagOps && (!archiveOrphanTagOps || archivedOrphanTagOps > 0 || orphanTagOps === 0),
      rootPath,
      dryRun,
      invalidTagJsonRows,
      repairedInvalidTagJsonRows,
      invalidTagOps,
      purgedInvalidTagOps,
      orphanTagOps,
      archivedOrphanTagOps,
      purgedOrphanTagOps,
      orphanArchiveReason,
      orphanArchiveTable: ORPHAN_ARCHIVE_TABLE,
      warnings,
      suggestedActions,
      repairedAt,
    }
  }

  return {
    repairSharedMetadataInOpenDb,
  }
}
