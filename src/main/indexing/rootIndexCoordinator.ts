import { resolve } from 'node:path'
import type { FontItem,FontQueryPageResult,FontQueryRequest,SystemInstalledFont } from '../../shared/types'
import { parseSqliteJson,sqliteTableExists } from '../db/sqliteHelpers'
import { fontQueryCacheKey } from '../library/fontQuerySqlRuntime'
import { buildRootIndexQuerySql,rootIndexJsonExpr,rootRelativePrefixForFolder,sqliteLiteral,type RootIndexPageRow } from './rootIndexQuerySql'
import type { FontScanCacheEntry } from './rootIndexRuntime'

type OpenRootIndexDb = (dbPath: string, rootPath: string, storage: 'root' | 'fallback', touchMeta?: boolean) => Promise<any>

type RuntimeFontStat = {
  size: number
  mtimeMs: number
  birthtimeMs?: number
  ctimeMs?: number
}

export interface RootIndexCoordinatorDeps {
  exists: (filePath: string) => Promise<boolean>
  rootCacheDir: (rootPath: string) => string
  rootIndexDbPath: (rootPath: string) => string
  resolveActiveRootIndexDbPath: (cacheDir: string, defaultDbPath: string) => Promise<string>
  installStatusDbPathForRoot: (rootPath: string) => Promise<string>
  openMachineInstallDbForRoot: (rootPath: string) => Promise<any>
  closeSqliteDb: (db: any) => void
  openRootIndexDb: OpenRootIndexDb
  sqliteRowToScanEntry: (row: {
    relative_path: string
    cache_key: string
    file_size: number
    modified_at: number
    created_at?: number
    status: string
    font_json?: string
    message?: string
    cached_at: string
  }) => FontScanCacheEntry
  cachedFontForRuntime: (font: FontItem, runtimePath: string, stat: RuntimeFontStat, relativePath?: string) => FontItem
  cacheEntryRuntimePath: (rootPath: string, relativePath: string) => string
  hydrateLocalTagsForFonts: (items: FontItem[]) => Promise<FontItem[]>
  compareSharedFonts: (a: FontItem, b: FontItem, request: FontQueryRequest) => number
  appWatchedFolders: () => Promise<string[]>
  appendStartupLog: (message: string) => void
}

export function createRootIndexCoordinator(deps: RootIndexCoordinatorDeps) {
  function rootIndexSqliteJsonAvailable(db: any): boolean {
    try {
      const row = db
        .prepare('SELECT json_extract(\'{"a":1}\', \'$.a\') AS value')
        .get() as { value?: number } | undefined
      return Number(row?.value || 0) === 1
    } catch {
      return false
    }
  }

  async function activeRootIndexDbPathForRoot(rootPath: string): Promise<string> {
    const resolvedRoot = resolve(rootPath)
    const rootDir = deps.rootCacheDir(resolvedRoot)
    const defaultPath = deps.rootIndexDbPath(resolvedRoot)
    return deps.resolveActiveRootIndexDbPath(rootDir, defaultPath).catch(() => defaultPath)
  }

  async function attachInstallStatusDbIfAvailable(db: any, rootPath: string): Promise<boolean> {
    try {
      const installDbPath = await deps.installStatusDbPathForRoot(rootPath)
      if (!(await deps.exists(installDbPath))) return false
      const installDb = await deps.openMachineInstallDbForRoot(rootPath)
      deps.closeSqliteDb(installDb)
      db.exec(`ATTACH DATABASE ${sqliteLiteral(installDbPath)} AS install_db`)
      return sqliteTableExists(db, 'install_db.install_status') || true
    } catch (error) {
      deps.appendStartupLog(
        `root index page query install status attach skipped: ${rootPath} ${error instanceof Error ? error.message : String(error)}`,
      )
      try {
        db.exec('DETACH DATABASE install_db')
      } catch {
        /* ignore */
      }
      return false
    }
  }

  function fontFromRootIndexPageRow(rootPath: string, row: RootIndexPageRow): FontItem | null {
    const entry = deps.sqliteRowToScanEntry({
      relative_path: row.relative_path,
      cache_key: row.cache_key,
      file_size: Number(row.file_size || 0),
      modified_at: Number(row.modified_at || 0),
      created_at:
        row.created_at === null || row.created_at === undefined
          ? undefined
          : Number(row.created_at),
      status: row.status,
      font_json: row.font_json || undefined,
      message: row.message || undefined,
      cached_at: row.cached_at,
    })
    if (!entry.font || entry.status !== 'ok') return null
    const font = deps.cachedFontForRuntime(
      entry.font,
      deps.cacheEntryRuntimePath(rootPath, row.relative_path || entry.path || ''),
      {
        size: Number(row.file_size || 0),
        mtimeMs: Number(row.modified_at || 0),
        birthtimeMs:
          row.created_at === null || row.created_at === undefined
            ? undefined
            : Number(row.created_at),
        ctimeMs:
          row.created_at === null || row.created_at === undefined
            ? undefined
            : Number(row.created_at),
      },
      row.relative_path || entry.path || undefined,
    )
    const sourceId = String(entry.font.id || '')
    if (row.installed !== null && row.installed !== undefined) {
      const installedBy = String(row.installed_by || 'none')
      return {
        ...font,
        sourceId,
        installStatusKnown: true,
        systemInstalled: !!row.installed && installedBy !== 'managed',
        systemInstallMatches: parseSqliteJson<SystemInstalledFont[]>(row.matches_json, []),
        active: font.active || installedBy === 'managed' || installedBy === 'both',
      }
    }
    return { ...font, sourceId, installStatusKnown: false }
  }

  async function findFontItemInRootIndexes(fontId: string, normalizedFontPath: string): Promise<FontItem | null> {
    const roots = await deps.appWatchedFolders().catch(() => [])
    for (const rawRoot of roots || []) {
      const root = resolve(rawRoot)
      const dbPath = await activeRootIndexDbPathForRoot(root)
      if (!(await deps.exists(dbPath))) continue
      const db = await deps.openRootIndexDb(dbPath, root, 'root', false)
      try {
        const clauses = [
          `COALESCE(is_deleted, 0) = 0`,
          `status = 'ok'`,
          `font_json IS NOT NULL`,
        ]
        const params: unknown[] = []
        const matchClauses: string[] = []
        if (fontId) {
          matchClauses.push(`${rootIndexJsonExpr('id')} = ?`)
          params.push(fontId)
        }
        if (normalizedFontPath) {
          const rel = rootRelativePrefixForFolder(root, normalizedFontPath)
          matchClauses.push(`LOWER(${rootIndexJsonExpr('path')}) = ?`)
          params.push(normalizedFontPath)
          if (rel !== null) {
            matchClauses.push('LOWER(relative_path) = ?')
            params.push(rel)
          }
        }
        if (!matchClauses.length) return null
        clauses.push(`(${matchClauses.join(' OR ')})`)
        const row = db
          .prepare(
            `
        SELECT relative_path, cache_key, file_size, modified_at, created_at, status, font_json, message, cached_at, NULL AS installed, NULL AS installed_by, NULL AS matches_json
        FROM entries
        WHERE ${clauses.join(' AND ')}
        LIMIT 1
      `,
          )
          .get(...params) as RootIndexPageRow | undefined
        if (!row) continue
        const font = fontFromRootIndexPageRow(root, row)
        if (font) return font
      } catch (error) {
        deps.appendStartupLog(
          `find font in root index skipped: ${root} ${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        deps.closeSqliteDb(db)
      }
    }
    return null
  }

  async function queryFontPageFromRootIndexes(
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ): Promise<FontQueryPageResult | null> {
    const startedAt = Date.now()
    const folders = await deps.appWatchedFolders()
    const roots = Array.from(new Set((folders || []).filter(Boolean).map((folder) => resolve(folder))))
    if (!roots.length) {
      return {
        queryKey: fontQueryCacheKey({ ...request, limit, offset }),
        items: [],
        total: 0,
        offset,
        limit,
        truncated: false,
        engine: 'sql',
        elapsedMs: Date.now() - startedAt,
      }
    }

    const rootResults: Array<{ root: string; total: number; rows: RootIndexPageRow[] }> = []
    let usedLike = false
    for (const root of roots) {
      const dbPath = await activeRootIndexDbPathForRoot(root)
      if (!(await deps.exists(dbPath))) continue
      const db = await deps.openRootIndexDb(dbPath, root, 'root', false)
      try {
        if (!rootIndexSqliteJsonAvailable(db)) return null
        const hasInstallJoin = await attachInstallStatusDbIfAvailable(db, root)
        const rootLimit = roots.length === 1 ? limit : Math.min(5000, offset + limit)
        const rootOffset = roots.length === 1 ? offset : 0
        const built = buildRootIndexQuerySql(root, request, hasInstallJoin, rootLimit, rootOffset)
        if (built.unsupportedReason) {
          deps.appendStartupLog(`root index page query fallback: ${built.unsupportedReason}`)
          return null
        }
        usedLike = usedLike || built.usedLike
        const totalRow = db.prepare(built.countSql).get(...built.countParams) as { count?: number } | undefined
        const total = Number(totalRow?.count || 0)
        if (total <= 0) {
          rootResults.push({ root, total: 0, rows: [] })
          continue
        }
        const rows = db.prepare(built.sql).all(...built.params) as RootIndexPageRow[]
        rootResults.push({ root, total, rows })
      } finally {
        deps.closeSqliteDb(db)
      }
    }

    const total = rootResults.reduce((sum, item) => sum + item.total, 0)
    if (roots.length === 1) {
      const only = rootResults[0]
      const items = await deps.hydrateLocalTagsForFonts(
        (only?.rows || [])
          .map((row) => fontFromRootIndexPageRow(only.root, row))
          .filter((font): font is FontItem => !!font),
      )
      deps.appendStartupLog(
        `root index page query: roots=1, total=${total}, items=${items.length}, offset=${offset}, limit=${limit}, page=${request.sidebarPage || 'library'}, activeFilter=${request.activeFilter?.kind || 'all'}, selectedFolder=${request.selectedFolderId || ''}, installStatus=${request.installStatus || 'all'}, elapsed=${Date.now() - startedAt}ms`,
      )
      return {
        queryKey: fontQueryCacheKey({ ...request, limit, offset }),
        items,
        total,
        offset,
        limit,
        truncated: offset + items.length < total,
        engine: usedLike || request.keyword ? 'like' : 'sql',
        elapsedMs: Date.now() - startedAt,
      }
    }

    const merged = rootResults
      .flatMap((result) =>
        result.rows
          .map((row) => fontFromRootIndexPageRow(result.root, row))
          .filter((font): font is FontItem => !!font),
      )
      .sort((a, b) => deps.compareSharedFonts(a, b, request))
    const items = await deps.hydrateLocalTagsForFonts(merged.slice(offset, offset + limit))
    deps.appendStartupLog(
      `root index page query: roots=${roots.length}, total=${total}, merged=${merged.length}, items=${items.length}, offset=${offset}, limit=${limit}, page=${request.sidebarPage || 'library'}, activeFilter=${request.activeFilter?.kind || 'all'}, selectedFolder=${request.selectedFolderId || ''}, installStatus=${request.installStatus || 'all'}, elapsed=${Date.now() - startedAt}ms`,
    )
    return {
      queryKey: fontQueryCacheKey({ ...request, limit, offset }),
      items,
      total,
      offset,
      limit,
      truncated: offset + items.length < total,
      engine: usedLike || request.keyword ? 'like' : 'sql',
      elapsedMs: Date.now() - startedAt,
    }
  }

  return {
    rootIndexSqliteJsonAvailable,
    activeRootIndexDbPathForRoot,
    attachInstallStatusDbIfAvailable,
    fontFromRootIndexPageRow,
    findFontItemInRootIndexes,
    queryFontPageFromRootIndexes,
  }
}
