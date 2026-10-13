import { win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import { runtimeFontIdFromEntry } from '../../fonts/fontFileIdentity'
import { INSTALL_STATUS_PROJECTION_VERSION, rootInstallStatusSignature } from '../../install/status/installStatusSignatureRuntime'
import type { MergedIndexSourceInfo } from '../mergedIndexRuntime'

// One-time local repair of derived flags. The cached font population and its
// root/metadata receipts survive even when a watched root is offline.
export async function migrateMergedInstallAuthority(db: any, options: {
  machineDirectory: string
  exists: (path: string) => Promise<boolean>
  open: (path: string, label: string) => any
  close: (db: any) => void
  getMeta: (db: any, key: string) => string
  setMeta: (db: any, key: string, value: string) => void
  sourcesKey: (sources: MergedIndexSourceInfo[]) => string
  appendLog: (line: string) => void
}): Promise<void> {
  if (options.getMeta(db, 'installEvidenceVersion') === INSTALL_STATUS_PROJECTION_VERSION) return
  const sources = db.prepare('SELECT * FROM sources').all() as Array<Record<string, string>>
  const available = new Set<string>()
  const machineDirectory = normalizePathForCacheCompare(options.machineDirectory)
  for (const path of new Set(sources.map(source => source.install_db_path).filter(Boolean))) {
    // Historical source receipts are not permission to open an offline NAS.
    const candidate = normalizePathForCacheCompare(path)
    if (!/^[a-z]:\\/i.test(candidate) || candidate.split('\\').some(part => part === '.' || part === '..')) continue
    const relative = win32.relative(win32.resolve(machineDirectory), win32.resolve(candidate))
    if (relative && relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative) && await options.exists(path)) available.add(path)
  }
  // All reads/writes below are synchronous within the local migration. Each
  // machine DB is pinned to one read snapshot before its rows are inspected.
  const readers = new Map<string, { db: any; select: any }>()
  const failed = new Set<string>()
  try {
    for (const path of available) {
      let reader: any
      try {
        reader = options.open(path, 'install-authority-migration')
        reader.exec('BEGIN')
        readers.set(path, { db: reader, select: reader.prepare('SELECT signature, installed, by_type, matches_json FROM install_status WHERE font_id=?') })
      } catch {
        failed.add(path)
        if (reader) options.close(reader)
        continue
      }
    }
    if (options.getMeta(db, 'installEvidenceVersion') === INSTALL_STATUS_PROJECTION_VERSION) return
    db.exec('BEGIN IMMEDIATE')
    try {
      const sourceRows = db.prepare('SELECT * FROM sources').all() as Array<Record<string, string>>
      const toSource = (row: Record<string, string>): MergedIndexSourceInfo => ({ root: row.root_path,
        indexDbPath: row.index_db_path, installDbPath: row.install_db_path || undefined,
        indexSignature: row.index_signature, installSignature: row.install_signature,
        sharedMetadataSignature: row.shared_metadata_signature })
      const previousKey = options.sourcesKey(sourceRows.map(toSource))
      const rows = db.prepare("SELECT root_path,relative_path,file_size,modified_at,font_json FROM entries WHERE COALESCE(is_deleted,0)=0 AND status='ok' AND json_valid(font_json)").all()
      const sourcesByRoot = new Map(sourceRows.map(source => [source.root_path, source]))
      const prepared = rows.map((row: any) => {
        const source = sourcesByRoot.get(row.root_path)
        let status: any
        let id: string
        const expected = rootInstallStatusSignature(row.root_path, row.relative_path, row.file_size, row.modified_at, row.font_json)
        // Malformed cached metadata invalidates only its own row, not the
        // otherwise readable machine database shared by all watched roots.
        try { id = runtimeFontIdFromEntry(row.root_path, row.relative_path, row.file_size, row.modified_at) }
        catch { return { row, status: undefined, cause: 'invalid-row', id: undefined } }
        if (!expected) return { row, status: undefined, cause: 'invalid-row', id }
        let cause = 'unavailable-authority'
        try {
          const reader = readers.get(source?.install_db_path || '')
          status = reader?.select.get(id)
          cause = !reader ? 'unavailable-authority' : !status ? 'missing-row'
            : String(status.signature || '').startsWith('unknown:') ? 'explicit-unknown'
            : status.signature !== expected ? 'signature-mismatch'
            : ![0, 1].includes(status.installed) ? 'invalid-row' : 'exact-known'
          if (cause !== 'exact-known') status = undefined
        } catch { if (source?.install_db_path) failed.add(source.install_db_path); status = undefined; cause = 'unavailable-authority' }
        return { row, status, cause, id }
      })
      const causes: Record<string, number> = {}
      const examples: Array<{ idHash: string; cause: string }> = []
      const update = db.prepare('UPDATE entries SET installed=?,installed_by=?,matches_json=? WHERE root_path=? AND relative_path=?')
      for (const { row, status: raw, cause: readCause, id } of prepared) {
        const source = sourcesByRoot.get(row.root_path)
        const unavailable = failed.has(source?.install_db_path || '')
        const status = unavailable ? undefined : raw
        const cause = unavailable ? 'unavailable-authority' : readCause
        causes[cause] = (causes[cause] || 0) + 1
        if (id && cause !== 'exact-known' && examples.length < 3) examples.push({ idHash: createHash('sha256').update(id).digest('hex').slice(0, 12), cause })
        update.run(status?.installed ?? null, status?.by_type ?? null, status?.matches_json ?? null, row.root_path, row.relative_path)
      }
      // A failed authority cannot keep an apparently fresh install receipt.
      // Index/shared metadata revisions remain exactly as previously applied.
      for (const source of sourceRows) if (!readers.has(source.install_db_path) || failed.has(source.install_db_path)) {
        if (source.install_signature === 'none' && !source.install_db_path) continue
        source.install_signature = 'pending:install-signature-authority'
        db.prepare('UPDATE sources SET install_signature=? WHERE root_path=?').run(source.install_signature, source.root_path)
      }
      if (options.getMeta(db, 'sourcesKey') === previousKey) options.setMeta(db, 'sourcesKey', options.sourcesKey(sourceRows.map(toSource)))
      options.setMeta(db, 'installEvidenceVersion', INSTALL_STATUS_PROJECTION_VERSION)
      db.exec('COMMIT')
      try { options.appendLog(`install authority projection migration: rows=${rows.length}, sources=${sourceRows.length}, unavailable=${sourceRows.filter(source => source.install_signature === 'pending:install-signature-authority').length}, version=${INSTALL_STATUS_PROJECTION_VERSION}, causes=${JSON.stringify(causes)}, examples=${JSON.stringify(examples)}, sourceHashes=${JSON.stringify(sourceRows.filter(source => source.install_signature === 'pending:install-signature-authority').slice(0, 3).map(source => createHash('sha256').update(source.root_path).digest('hex').slice(0, 12)))}`) } catch { /* The committed migration is independent of diagnostic delivery. */ }
    } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  } finally {
    for (const reader of readers.values()) options.close(reader.db)
  }
}
