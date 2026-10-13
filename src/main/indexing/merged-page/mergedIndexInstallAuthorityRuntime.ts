import { win32 } from 'node:path'
import { createHash } from 'node:crypto'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import { runtimeFontIdFromEntry } from '../../fonts/fontFileIdentity'
import { INSTALL_STATUS_PROJECTION_VERSION, rootInstallStatusSignature } from '../../install/status/installStatusSignatureRuntime'
import { installStatusContentSignatureFromDb } from '../../install/status/installStatusContentSignatureRuntime'
import type { MergedIndexSourceInfo } from '../mergedIndexRuntime'

// Local repair of derived flags for migration, process restart and committed
// status writes. Root population/metadata receipts survive offline roots.
export async function migrateMergedInstallAuthority(db: any, options: {
  machineDirectory: string
  exists: (path: string) => Promise<boolean>
  open: (path: string, label: string) => any
  close: (db: any) => void
  getMeta: (db: any, key: string) => string
  setMeta: (db: any, key: string, value: string) => void
  sourcesKey: (sources: MergedIndexSourceInfo[]) => string
  appendLog: (line: string) => void
  force?: boolean
  acknowledgeSources?: boolean
  assertCurrent?: () => void
}): Promise<{ changed: number; unavailable: number }> {
  options.assertCurrent?.()
  if (!options.force && options.getMeta(db, 'installEvidenceVersion') === INSTALL_STATUS_PROJECTION_VERSION) return { changed: 0, unavailable: 0 }
  const sources = db.prepare('SELECT * FROM sources').all() as Array<Record<string, string>>
  const available = new Set<string>()
  const machineDirectory = normalizePathForCacheCompare(options.machineDirectory)
  for (const path of new Set(sources.map(source => source.install_db_path).filter(Boolean))) {
    // Historical source receipts are not permission to open an offline NAS.
    const candidate = normalizePathForCacheCompare(path)
    if (!/^[a-z]:\\/i.test(candidate) || candidate.split('\\').some(part => part === '.' || part === '..')) continue
    const relative = win32.relative(win32.resolve(machineDirectory), win32.resolve(candidate))
    if (relative && relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative) && await options.exists(path)) available.add(path)
    options.assertCurrent?.()
  }
  // All reads/writes below are synchronous within the local migration. Each
  // machine DB is pinned to one read snapshot before its rows are inspected.
  const readers = new Map<string, { db: any; select: any; signature?: string }>()
  const failed = new Set<string>()
  try {
    for (const path of available) {
      let reader: any
      try {
        reader = options.open(path, 'install-authority-migration')
        reader.exec('BEGIN')
        readers.set(path, { db: reader, select: reader.prepare('SELECT signature, installed, by_type, matches_json FROM install_status WHERE font_id=?'),
          signature: options.acknowledgeSources ? installStatusContentSignatureFromDb(reader) : undefined })
      } catch {
        failed.add(path)
        if (reader) { try { reader.exec('ROLLBACK') } catch {} options.close(reader) }
        continue
      }
    }
    if (!options.force && options.getMeta(db, 'installEvidenceVersion') === INSTALL_STATUS_PROJECTION_VERSION) return { changed: 0, unavailable: 0 }
    options.assertCurrent?.()
    db.exec('BEGIN IMMEDIATE')
    try {
      const sourceRows = db.prepare('SELECT * FROM sources').all() as Array<Record<string, string>>
      const toSource = (row: Record<string, string>): MergedIndexSourceInfo => ({ root: row.root_path,
        indexDbPath: row.index_db_path, installDbPath: row.install_db_path || undefined,
        indexSignature: row.index_signature, installSignature: row.install_signature,
        sharedMetadataSignature: row.shared_metadata_signature })
      const previousKey = options.sourcesKey(sourceRows.map(toSource))
      const rows = db.prepare("SELECT root_path,relative_path,file_size,modified_at,font_json,installed,installed_by,matches_json FROM entries WHERE COALESCE(is_deleted,0)=0 AND status='ok' AND json_valid(font_json)").all()
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
      let changed = 0
      const update = db.prepare('UPDATE entries SET installed=?,installed_by=?,matches_json=? WHERE root_path=? AND relative_path=? AND (installed IS NOT ? OR installed_by IS NOT ? OR matches_json IS NOT ?)')
      for (const { row, status: raw, cause: readCause, id } of prepared) {
        const source = sourcesByRoot.get(row.root_path)
        const unavailable = failed.has(source?.install_db_path || '')
        const status = unavailable ? undefined : raw
        const cause = unavailable ? 'unavailable-authority' : readCause
        causes[cause] = (causes[cause] || 0) + 1
        if (id && cause !== 'exact-known' && examples.length < 3) examples.push({ idHash: createHash('sha256').update(id).digest('hex').slice(0, 12), cause })
        const values = [status?.installed ?? null, status?.by_type ?? null, status?.matches_json ?? null]
        // The complete authority read still repairs debt outside this writer's
        // batch. Avoid a keyed SQLite call only when all projected values from
        // this same write transaction are already exact, including NULL.
        if (row.installed === values[0] && row.installed_by === values[1] && row.matches_json === values[2]) continue
        changed += Number(update.run(...values, row.root_path, row.relative_path, ...values).changes || 0)
      }
      // A failed authority cannot keep an apparently fresh install receipt.
      // Index/shared metadata revisions remain exactly as previously applied.
      for (const source of sourceRows) {
        let signature = source.install_signature
        if (!readers.has(source.install_db_path) || failed.has(source.install_db_path)) {
          if (signature === 'none' && !source.install_db_path) continue
          signature = 'pending:install-signature-authority'
        } else if (options.acknowledgeSources) {
          signature = readers.get(source.install_db_path)!.signature!
        }
        if (signature !== source.install_signature) {
          source.install_signature = signature
          db.prepare('UPDATE sources SET install_signature=? WHERE root_path=?').run(signature, source.root_path)
        }
      }
      if (options.getMeta(db, 'sourcesKey') === previousKey) options.setMeta(db, 'sourcesKey', options.sourcesKey(sourceRows.map(toSource)))
      options.setMeta(db, 'installEvidenceVersion', INSTALL_STATUS_PROJECTION_VERSION)
      options.assertCurrent?.()
      db.exec('COMMIT')
      try { options.appendLog(`install authority projection migration: rows=${rows.length}, sources=${sourceRows.length}, unavailable=${sourceRows.filter(source => source.install_signature === 'pending:install-signature-authority').length}, version=${INSTALL_STATUS_PROJECTION_VERSION}, causes=${JSON.stringify(causes)}, examples=${JSON.stringify(examples)}, sourceHashes=${JSON.stringify(sourceRows.filter(source => source.install_signature === 'pending:install-signature-authority').slice(0, 3).map(source => createHash('sha256').update(source.root_path).digest('hex').slice(0, 12)))}`) } catch { /* The committed migration is independent of diagnostic delivery. */ }
      return { changed, unavailable: sourceRows.filter(source => source.install_signature === 'pending:install-signature-authority').length }
    } catch (error) { try { db.exec('ROLLBACK') } catch {} throw error }
  } finally {
    for (const reader of readers.values()) {
      try { reader.db.exec('ROLLBACK') } catch {}
      options.close(reader.db)
    }
  }
}
