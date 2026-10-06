import os from 'node:os'
import { resolve } from 'node:path'
import type { RustSharedMetadataOverlayReadInput, RustSharedMetadataOverlayReadResult } from '../rust-core/rustCoreWorkerContracts'
import { normalizePathForCacheCompare as key } from '../path/cachePath'
import { sharedMetadataDbPathForRoot } from '../indexing/shared-metadata/sharedMetadataPathsRuntime'
import { stateFromRow } from '../indexing/shared-metadata/sharedMetadataStateRuntime'
import type { TagRecoveryPaths } from './tagRecoveryPathRuntime'

export type TagFontBinding = { path: string; id: string; tags: string[] }

// Tag membership is authoritative here; font snapshots only supply display data.
// A failed shared read may use a prior snapshot for display, never for a write.
export async function readTagFontBindings(options: {
  db: any
  paths: TagRecoveryPaths
  scope: 'local' | 'shared'
  folders?: string[]
  readShared: (input: RustSharedMetadataOverlayReadInput) => Promise<RustSharedMetadataOverlayReadResult | null>
}) {
  const { db, paths, scope } = options
  const inScope = (path: string) => !options.folders?.length || options.folders.some(root => paths.inside(path, root))
  const bindings = new Map<string, TagFontBinding>()
  const legacyTags = new Map<string, string[]>()
  const unavailableRoots: string[] = []
  let complete = true
  if (scope === 'local') {
    const prefixes = [...new Set((options.folders || []).flatMap(folder => paths.aliases(folder)).map(folder => folder.replace(/\\+$/, '')))]
    const normalized = "lower(replace(trim(font_path), '/', char(92)))"
    const escape = (value: string) => value.replace(/[!%_]/g, character => '!' + character)
    // Legacy noncanonical paths may contain Unicode case folds, dot segments or
    // repeated separators. Keep that small compatibility subset for JS checking.
    const legacy = `font_path GLOB '*[^ -~]*' OR instr(${normalized}, char(92)||'.') > 0 OR instr(substr(${normalized},3),char(92)||char(92)) > 0`
    const rows: Array<{ font_id: string; font_path: string | null; tag_name: string }> = []
    // Bound expression depth and variable count for large multi-directory batches.
    for (let index = 0; index < Math.max(1, prefixes.length); index += 128) {
      const group = prefixes.slice(index, index + 128)
      const where = group.length ? ` WHERE COALESCE(font_path, '') = '' OR ${group.map(() => `(${normalized} = ? OR ${normalized} LIKE ? ESCAPE '!')`).join(' OR ')} OR ${legacy}` : ''
      rows.push(...db.prepare('SELECT font_id, font_path, tag_name FROM local_font_tags' + where)
        .all(...group.flatMap(prefix => [prefix, escape(prefix) + '\\%'])))
    }
    for (const row of rows) {
      if (!row.font_path) {
        const tags = legacyTags.get(row.font_id) || []
        if (!tags.includes(row.tag_name)) tags.push(row.tag_name)
        legacyTags.set(row.font_id, tags)
        continue
      }
      if (!inScope(row.font_path)) continue
      const binding = bindings.get(key(row.font_path)) || { path: row.font_path, id: row.font_id, tags: [] }
      if (!binding.tags.includes(row.tag_name)) binding.tags.push(row.tag_name)
      bindings.set(key(row.font_path), binding)
    }
  } else {
    db.exec('CREATE TABLE IF NOT EXISTS tag_shared_binding_snapshots (root_path TEXT PRIMARY KEY, rows_json TEXT NOT NULL)')
    for (const root of paths.roots.filter(root => !options.folders?.length || options.folders.some(folder => paths.inside(folder, root) || paths.inside(root, folder)))) {
      let rows: import('../indexing/shared-metadata/sharedMetadataStateRuntime').SharedMetadataRow[]
      try {
        const result = await options.readShared({ rootPath: root, dbPath: sharedMetadataDbPathForRoot(root), entries: [],
          preflight: { phase: 'snapshot', updatedAt: new Date().toISOString(), updatedBy: os.hostname(), writerPid: process.pid } })
        if (!result?.preflight?.snapshot?.rows) throw new Error('共享标签快照未确认。')
        rows = result.preflight.snapshot.rows
        db.prepare('INSERT OR REPLACE INTO tag_shared_binding_snapshots (root_path, rows_json) VALUES (?, ?)').run(paths.compare(root), JSON.stringify(rows))
      } catch (error) {
        const cached = db.prepare('SELECT rows_json FROM tag_shared_binding_snapshots WHERE root_path = ?').get(paths.compare(root))
          || (db.prepare('SELECT root_path, rows_json FROM tag_shared_binding_snapshots').all() as Array<{ root_path: string; rows_json: string }>)
            .find(row => paths.compare(row.root_path) === paths.compare(root))
        if (!cached) complete = false
        try { rows = cached ? JSON.parse(cached.rows_json) : [] } catch { throw error }
        if (!Array.isArray(rows)) throw error
        unavailableRoots.push(root)
      }
      for (const row of rows) {
        const state = stateFromRow(row)
        if (!state?.tagNames.length || !row.relative_path) continue
        const path = resolve(root, row.relative_path)
        if (!paths.inside(path, root) || !inScope(path)) continue
        bindings.set(key(path), { path, id: String(row.font_id || ''), tags: state.tagNames })
      }
    }
  }
  return { bindings, legacyTags, unavailableRoots, complete }
}
