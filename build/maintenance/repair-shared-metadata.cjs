#!/usr/bin/env node
/**
 * Shared metadata repair command.
 * Dry-run by default. Pass --apply to modify the database.
 * Usage:
 *   node build/maintenance/repair-shared-metadata.cjs --root "X:\\Fonts" --apply
 *   node build/maintenance/repair-shared-metadata.cjs --db "X:\\Fonts\\.hfm-cache\\database\\shared-metadata.sqlite" --json
 *   node build/maintenance/repair-shared-metadata.cjs --root "X:\\Fonts" --apply --archive-orphans --purge-archived-orphans
 */
const path = require('node:path')

function parseArgs(argv) {
  const out = { apply: false, json: false, root: '', db: '', archiveOrphans: false, purgeArchivedOrphans: false, orphanArchiveReason: 'orphan-font-metadata' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--json') out.json = true
    else if (arg === '--root') out.root = argv[++i] || ''
    else if (arg === '--db') out.db = argv[++i] || ''
    else if (arg === '--archive-orphans') out.archiveOrphans = true
    else if (arg === '--purge-archived-orphans') out.purgeArchivedOrphans = true
    else if (arg === '--orphan-archive-reason') out.orphanArchiveReason = argv[++i] || out.orphanArchiveReason
  }
  return out
}

function usage() {
  return [
    'Usage:',
    '  node build/maintenance/repair-shared-metadata.cjs --root <watched-root> [--apply] [--json]',
    '  node build/maintenance/repair-shared-metadata.cjs --db <shared-metadata.sqlite> [--apply] [--json]',
    '  node build/maintenance/repair-shared-metadata.cjs --root <watched-root> --apply --archive-orphans [--purge-archived-orphans]',
    '',
    'Default mode is dry-run. --apply repairs invalid tag JSON and purges invalid shared_tag_ops rows.',
    'Orphan shared_tag_ops are never removed unless --archive-orphans is set; --purge-archived-orphans removes only rows already copied to shared_tag_ops_archive.',
  ].join('\n')
}

function tableExists(db, tableName) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name=?").get(tableName)
  return Number(row && row.count || 0) > 0
}

function parseTags(value) {
  const text = String(value || '')
  if (!text) return { ok: true, normalizedJson: '[]' }
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) return { ok: false, normalizedJson: '[]' }
    const seen = new Set()
    const tags = []
    for (const item of parsed) {
      const tag = String(item || '').trim()
      if (!tag || seen.has(tag)) continue
      seen.add(tag)
      tags.push(tag)
    }
    return { ok: true, normalizedJson: JSON.stringify(tags) }
  } catch {
    return { ok: false, normalizedJson: '[]' }
  }
}

function ensureArchiveTable(db) {
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

function archiveOrphans(db, now, reason, purge) {
  ensureArchiveTable(db)
  const inserted = db.prepare(`
    INSERT OR IGNORE INTO shared_tag_ops_archive (
      archived_at, archive_reason, source_table, op_id, font_id, relative_path, path_key, action, tag_name,
      base_revision, next_revision, created_at, machine_id, writer_pid, tombstone, payload_json
    )
    SELECT ?, ?, 'shared_tag_ops', ops.op_id, ops.font_id, ops.relative_path, ops.path_key, ops.action, ops.tag_name,
      ops.base_revision, ops.next_revision, ops.created_at, ops.machine_id, ops.writer_pid, ops.tombstone,
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
  `).run(now, reason)
  let purged = 0
  if (purge) {
    purged = Number(db.prepare(`
      DELETE FROM shared_tag_ops
      WHERE op_id IN (
        SELECT op_id FROM shared_tag_ops_archive
        WHERE source_table = 'shared_tag_ops' AND archive_reason = ?
      )
        AND font_id NOT IN (SELECT font_id FROM font_metadata)
    `).run(reason).changes || 0)
  }
  return { archived: Number(inserted.changes || 0), purged }
}

function repair(db, dbPath, args) {
  const dryRun = !args.apply
  const now = new Date().toISOString()
  const report = {
    ok: true,
    dbPath,
    dryRun,
    invalidTagJsonRows: 0,
    repairedInvalidTagJsonRows: 0,
    invalidTagOps: 0,
    purgedInvalidTagOps: 0,
    orphanTagOps: 0,
    archivedOrphanTagOps: 0,
    purgedOrphanTagOps: 0,
    orphanArchiveReason: args.orphanArchiveReason,
    suggestedActions: [],
  }

  if (!tableExists(db, 'font_metadata')) {
    report.ok = false
    report.suggestedActions.push('font_metadata table is missing; open the database through the app to initialize schema')
    return report
  }

  const rows = db.prepare('SELECT font_id, tag_names_json FROM font_metadata').all()
  const invalidRows = rows.map((row) => ({ row, parsed: parseTags(row.tag_names_json) })).filter((entry) => !entry.parsed.ok)
  report.invalidTagJsonRows = invalidRows.length

  if (args.apply && invalidRows.length) {
    const update = db.prepare("UPDATE font_metadata SET tag_names_json='[]', revision=COALESCE(revision,0)+1, updated_at=?, updated_by='maintenance-repair' WHERE font_id=?")
    const tx = db.transaction(() => {
      for (const entry of invalidRows) {
        const fontId = String(entry.row.font_id || '')
        if (!fontId) continue
        report.repairedInvalidTagJsonRows += Number(update.run(now, fontId).changes || 0)
      }
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('sharedMetadataRepairAt', now)
    })
    tx()
  }

  if (tableExists(db, 'shared_tag_ops')) {
    const invalidOps = db.prepare(`
      SELECT op_id FROM shared_tag_ops
      WHERE COALESCE(font_id, '') = ''
        OR COALESCE(tag_name, '') = ''
        OR action NOT IN ('addTag', 'removeTag')
    `).all()
    report.invalidTagOps = invalidOps.length
    const orphan = db.prepare(`
      SELECT COUNT(*) AS count
      FROM shared_tag_ops ops
      LEFT JOIN font_metadata meta ON meta.font_id = ops.font_id
      WHERE meta.font_id IS NULL
    `).get()
    report.orphanTagOps = Number(orphan && orphan.count || 0)
    if (args.apply && invalidOps.length) {
      const del = db.prepare('DELETE FROM shared_tag_ops WHERE op_id=?')
      const tx = db.transaction(() => {
        for (const row of invalidOps) report.purgedInvalidTagOps += Number(del.run(row.op_id).changes || 0)
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('sharedMetadataRepairInvalidTagOpsPurgedAt', now)
      })
      tx()
    }
    if (args.apply && args.archiveOrphans && report.orphanTagOps > 0) {
      const tx = db.transaction(() => {
        const result = archiveOrphans(db, now, args.orphanArchiveReason, args.purgeArchivedOrphans)
        report.archivedOrphanTagOps = result.archived
        report.purgedOrphanTagOps = result.purged
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('sharedTagOpsOrphanArchiveAt', now)
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('sharedTagOpsOrphanArchiveReason', args.orphanArchiveReason)
      })
      tx()
    }
  }

  if (report.invalidTagJsonRows && dryRun) report.suggestedActions.push('rerun with --apply to reset invalid tag_names_json rows to []')
  if (report.invalidTagOps && dryRun) report.suggestedActions.push('rerun with --apply to purge invalid shared_tag_ops rows')
  if (report.orphanTagOps && dryRun) report.suggestedActions.push('rerun with --apply --archive-orphans after confirming orphan ops belong to removed fonts')
  if (args.archiveOrphans && report.archivedOrphanTagOps && !args.purgeArchivedOrphans) report.suggestedActions.push('orphan shared_tag_ops were archived; add --purge-archived-orphans to remove archived rows')
  if (!report.suggestedActions.length) report.suggestedActions.push('no repair action required')
  report.ok = report.invalidTagJsonRows === 0 && report.invalidTagOps === 0 && (!args.archiveOrphans || report.orphanTagOps === 0 || report.archivedOrphanTagOps > 0)
  if (args.apply) report.ok = report.repairedInvalidTagJsonRows === report.invalidTagJsonRows && report.purgedInvalidTagOps === report.invalidTagOps && (!args.archiveOrphans || report.orphanTagOps === 0 || report.archivedOrphanTagOps > 0)
  return report
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dbPath = args.db || (args.root ? path.join(path.resolve(args.root), '.hfm-cache', 'database', 'shared-metadata.sqlite') : '')
  if (!dbPath) {
    console.error(usage())
    process.exit(1)
  }
  let Database
  try {
    Database = require('better-sqlite3')
  } catch (error) {
    console.error('better-sqlite3 is required. Run npm install before this maintenance command.')
    process.exit(2)
  }
  let db
  try {
    db = new Database(dbPath)
  } catch (error) {
    console.error(`failed to open shared metadata database: ${error && error.message ? error.message : String(error)}`)
    console.error('If this is a native binding error, run npm rebuild better-sqlite3 or use the packaged Electron environment.')
    process.exit(2)
  }
  try {
    const report = repair(db, dbPath, args)
    if (args.json) console.log(JSON.stringify(report, null, 2))
    else {
      console.log(`shared metadata repair ${args.apply ? 'apply' : 'dry-run'}: ${dbPath}`)
      console.log(`invalidTagJsonRows=${report.invalidTagJsonRows}, repaired=${report.repairedInvalidTagJsonRows}`)
      console.log(`invalidTagOps=${report.invalidTagOps}, purged=${report.purgedInvalidTagOps}`)
      console.log(`orphanTagOps=${report.orphanTagOps}, archived=${report.archivedOrphanTagOps}, purgedOrphans=${report.purgedOrphanTagOps}`)
      console.log(`suggestedActions=${report.suggestedActions.join('; ')}`)
    }
    process.exit(report.ok || args.apply ? 0 : 3)
  } finally {
    db.close()
  }
}

main()
