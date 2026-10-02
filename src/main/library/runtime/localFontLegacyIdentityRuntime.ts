import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import { normalizeLocalTagFontPath } from './localFontTagIdentityRuntime'
import { fileRuntimeFontId } from '../../fonts/fontFileIdentity'

type Db = any
type IndexRow = { root_path: string; relative_path: string; file_size: number; modified_at: number; font_json: string }
type LegacyRow = { kind: string; font_id: string; tag_name: string; payload_json: string }

// Archive original rows before removing unsafe ID-only bindings from active tables.
// The archive is also the retry source; no historical record is discarded.
export function ensureLocalFontIdentitySchema(db: Db): void {
  db.prepare(`CREATE TABLE IF NOT EXISTS local_font_legacy_state (
    kind TEXT NOT NULL, font_id TEXT NOT NULL, tag_name TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', resolved_path TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(kind, font_id, tag_name)
  )`).run()
  db.prepare('CREATE TABLE IF NOT EXISTS local_font_tag_decisions (font_path TEXT PRIMARY KEY)').run()
}

export function archivePathlessFontState(db: Db): number {
  ensureLocalFontIdentitySchema(db)
  let archived = 0
  const hasLegacy = ['local_font_tags','local_font_favorites'].some(table => db.prepare(`SELECT 1 FROM ${table} WHERE COALESCE(font_path,'')='' LIMIT 1`).get())
  if (!hasLegacy) return 0
  db.transaction(() => {
    const save = db.prepare("INSERT OR IGNORE INTO local_font_legacy_state(kind,font_id,tag_name,payload_json) VALUES (?,?,?,?)")
    for (const [table, kind] of [['local_font_tags', 'tag'], ['local_font_favorites', 'favorite']]) {
      const rows = db.prepare(`SELECT * FROM ${table} WHERE COALESCE(font_path, '') = ''`).all()
      for (const row of rows) {
        const existing = db.prepare('SELECT payload_json FROM local_font_legacy_state WHERE kind=? AND font_id=? AND tag_name=?').get(kind,row.font_id,row.tag_name || '')
        // An older client may have written the ID-only record again. Do not silently
        // overwrite its archived predecessor or remove the new value.
        if (existing && existing.payload_json !== JSON.stringify(row)) throw new Error('历史字体状态存在新的无路径写入，已保留原记录，需先处理归属冲突。')
        save.run(kind,row.font_id,row.tag_name || '',JSON.stringify(row))
        archived += 1
      }
      if (kind === 'tag' && rows.length) {
        const catalogRow = db.prepare("SELECT value FROM app_state WHERE key='localTags'").get()
        const catalog = catalogRow ? JSON.parse(catalogRow.value) : []
        if (!Array.isArray(catalog)) throw new Error('本地标签目录格式无效，未移动历史记录。')
        db.prepare("INSERT OR REPLACE INTO app_state(key,value) VALUES ('localTags',?)").run(JSON.stringify([...new Set([...catalog,...rows.map((row: any) => row.tag_name)])]))
      }
      db.prepare(`DELETE FROM ${table} WHERE COALESCE(font_path, '') = ''`).run()
    }
  })()
  return archived
}

export function reconcileLegacyFontState(db: Db, rows: IndexRow[] | null): { resolved: number; ambiguous: number; missing: number; deferred: number } {
  const pending = db.prepare("SELECT kind,font_id,tag_name,payload_json FROM local_font_legacy_state WHERE status IN ('pending','ambiguous','missing')").all() as LegacyRow[]
  const result = { resolved: 0, ambiguous: 0, missing: 0, deferred: 0 }
  if (!pending.length) return result
  if (!rows) { result.deferred = pending.length; return result }
  const wanted = new Set(pending.map(row => row.font_id.toLowerCase()))
  const paths = new Map<string, Set<string>>()
  const legacyId = (identity: string, size: number, mtime: number) => createHash('sha1').update(`${identity.toLowerCase()}|${size}|${Math.round(mtime)}`).digest('hex')
  for (const row of rows) {
    const source = JSON.parse(row.font_json)
    const path = normalizePathForCacheCompare(win32.isAbsolute(row.relative_path) ? row.relative_path : win32.join(row.root_path,row.relative_path))
    // Invalid rows invalidate the catalog rather than silently reducing ambiguity.
    const runtimeId = fileRuntimeFontId(path,Number(row.file_size),Number(row.modified_at))
    const aliases = [source.id, source.sourceId, runtimeId, legacyId(row.relative_path || source.path || path,row.file_size,row.modified_at), legacyId(path,row.file_size,row.modified_at)]
    for (const value of aliases) {
      const alias = String(value || '').toLowerCase()
      if (!wanted.has(alias)) continue
      if (!paths.has(alias)) paths.set(alias,new Set())
      paths.get(alias)!.add(path)
    }
  }
  const favoriteValues = new Map<string, Set<number>>()
  for (const row of pending.filter(row => row.kind === 'favorite')) {
    const candidates = paths.get(row.font_id.toLowerCase())
    if (candidates?.size !== 1) continue
    const path = [...candidates][0]
    if (!favoriteValues.has(path)) favoriteValues.set(path,new Set())
    favoriteValues.get(path)!.add(Number(JSON.parse(row.payload_json).favorite))
  }
  db.transaction(() => {
    const priorTagPaths = new Set<string>(db.prepare("SELECT DISTINCT font_path FROM local_font_tags WHERE font_path <> '' UNION SELECT font_path FROM local_font_tag_decisions").all().map((row: any) => normalizeLocalTagFontPath(row.font_path)))
    const priorFavoritePaths = new Set<string>(db.prepare("SELECT font_path FROM local_font_favorites WHERE font_path <> ''").all().map((row: any) => normalizePathForCacheCompare(row.font_path)))
    const status = db.prepare('UPDATE local_font_legacy_state SET status=?,resolved_path=? WHERE kind=? AND font_id=? AND tag_name=?')
    for (const row of pending) {
      const candidates = paths.get(row.font_id.toLowerCase())
      const count = candidates?.size || 0
      if (count !== 1) {
        const reason = count ? 'ambiguous' : 'missing'
        result[reason] += 1
        status.run(reason,'',row.kind,row.font_id,row.tag_name)
        continue
      }
      const path = [...candidates!][0]
      const payload = JSON.parse(row.payload_json)
      const storedPath = row.kind === 'tag' ? normalizeLocalTagFontPath(path) : path
      if (row.kind === 'favorite' && !priorFavoritePaths.has(storedPath) && (favoriteValues.get(path)?.size || 0) > 1) {
        result.ambiguous += 1
        status.run('ambiguous','',row.kind,row.font_id,row.tag_name)
        continue
      }
      const superseded = row.kind === 'tag' ? priorTagPaths.has(storedPath) : priorFavoritePaths.has(storedPath)
      if (!superseded) {
        if (row.kind === 'tag') db.prepare('INSERT OR IGNORE INTO local_font_tags(font_id,font_path,tag_name,updated_at) VALUES (?,?,?,?)').run(`local-path:${storedPath}`,storedPath,row.tag_name,payload.updated_at)
        else db.prepare('INSERT OR IGNORE INTO local_font_favorites(font_id,font_path,favorite) VALUES (?,?,?)').run(`local-path:${storedPath}`,storedPath,payload.favorite)
      }
      status.run(superseded ? 'superseded' : 'resolved',storedPath,row.kind,row.font_id,row.tag_name)
      result.resolved += 1
    }
  })()
  return result
}

export function createLocalFontLegacyIdentityRuntime(options: {
  readCompleteIndex: (roots: string[], force: boolean) => Promise<IndexRow[] | null | undefined>
  retryIndex?: () => void
  appendLog: (message: string) => void
  invalidate: () => void
}) {
  let inFlight: Promise<void> | undefined
  let lastReport = ''
  async function prepare(db: Db): Promise<void> {
    if (inFlight) return inFlight
    inFlight = (async () => {
      const archived = archivePathlessFontState(db)
      if (archived) options.invalidate()
      if (!db.prepare("SELECT 1 FROM local_font_legacy_state WHERE status IN ('pending','ambiguous','missing') LIMIT 1").get()) return
      const roots = () => (db.prepare('SELECT path FROM folders').all() as Array<{ path: string }>).map(row => normalizePathForCacheCompare(row.path)).sort()
      const before = roots()
      let report: ReturnType<typeof reconcileLegacyFontState>
      try {
        const snapshot = await options.readCompleteIndex(before,archived > 0)
        if (snapshot === undefined) return
        const unchangedRoots = JSON.stringify(before) === JSON.stringify(roots())
        if (!unchangedRoots) options.retryIndex?.()
        report = reconcileLegacyFontState(db,unchangedRoots ? snapshot : null)
      } catch (error) {
        options.retryIndex?.()
        // Archived originals remain available for retry. Never fall back to ID-only hydration.
        const message = `历史字体状态归属暂缓：${error instanceof Error ? error.message : String(error)}`
        if (message !== lastReport) options.appendLog(message)
        lastReport = message
        return
      }
      if (report.resolved) options.invalidate()
      const message = `历史字体状态归属：已处理=${report.resolved}，多义=${report.ambiguous}，无匹配=${report.missing}，索引不完整暂缓=${report.deferred}；原记录保存在本地归属档案。`
      if (message !== lastReport) options.appendLog(message)
      lastReport = message
    })()
    try { await inFlight } finally { inFlight = undefined }
  }
  return { prepare }
}

export function readCompleteFontIdentityIndex(db: Db, roots: string[]): IndexRow[] | null {
  return db.transaction(() => {
    const expected = [...new Set(roots.map(normalizePathForCacheCompare))].sort()
    const sources = db.prepare('SELECT root_path,index_signature FROM sources').all()
    if (sources.some((row: any) => !row.index_signature || ['missing','pending-snapshot'].includes(row.index_signature))) return null
    const actual = [...new Set<string>(sources.map((row: any) => normalizePathForCacheCompare(row.root_path)))].sort()
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return null
    const rows = db.prepare("SELECT root_path,relative_path,file_size,modified_at,font_json FROM entries WHERE COALESCE(is_deleted,0)=0 AND status='ok'").all() as IndexRow[]
    if (rows.some(row => !expected.includes(normalizePathForCacheCompare(row.root_path)))) return null
    return rows
  })()
}
