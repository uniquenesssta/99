import type { FontQueryRequest } from '../../../shared/types'
import {
addRootIndexJsonArrayAnyClause,
addRootIndexJsonArrayContainsClause,
addRootIndexKeywordClause,
addRootIndexPathPrefixClause,
addRootIndexTimeRangeClause,
rootIndexActiveExpr,
rootIndexInstalledExpr,
rootIndexJsonBoolExpr,
rootIndexJsonExpr,
rootIndexJsonTextExpr,
rootIndexNotInstalledExpr,
rootIndexSystemDefaultExpr,
rootRelativePrefixForFolder,
sanitizeStringArray,
} from './rootIndexQuerySharedSql'
import { addLegacyRootIndexCollectionContainsClause } from './legacy/legacyCollectionRootQueryRuntime'
import type { RootIndexQueryParts,RootIndexQuerySqlResult } from './rootIndexQueryTypes'

function addRootIndexActiveFilterClauses(parts: RootIndexQueryParts, request: FontQueryRequest): void {
  const filter = request.activeFilter || { kind: 'all' }
  switch (filter.kind) {
    case 'favorites':
      parts.clauses.push(`${rootIndexJsonBoolExpr('favorite')} = 1`)
      break
    case 'installed':
      parts.clauses.push(rootIndexInstalledExpr(parts.hasInstallJoin))
      break
    case 'notInstalled':
      parts.clauses.push(rootIndexNotInstalledExpr(parts.hasInstallJoin))
      break
    case 'active':
      parts.clauses.push(rootIndexActiveExpr(parts.hasInstallJoin))
      break
    case 'systemBuiltin':
    case 'cleanSystem':
      parts.clauses.push(rootIndexSystemDefaultExpr(parts.hasInstallJoin))
      break
    case 'format':
      if (filter.id) {
        parts.clauses.push(`${rootIndexJsonTextExpr('format')} = ?`)
        parts.params.push(String(filter.id).toLowerCase())
      }
      break
    case 'script':
      addRootIndexJsonArrayContainsClause(parts, 'scripts', filter.id || '')
      break
    case 'collection':
      addLegacyRootIndexCollectionContainsClause(parts, filter.id || '')
      break
    case 'tag':
      parts.unsupportedReason = 'local tag filter needs local app database'
      break
    case 'sharedTag':
      parts.unsupportedReason = 'shared tag filter needs shared metadata overlay'
      break
  }
}

function addRootIndexPageFilterClauses(parts: RootIndexQueryParts, rootPath: string, request: FontQueryRequest): void {
  const sidebarPage = request.sidebarPage || 'library'
  if (sidebarPage !== 'library') {
    if (request.installStatus === 'installed') parts.clauses.push(rootIndexInstalledExpr(parts.hasInstallJoin))
    if (request.installStatus === 'notInstalled') parts.clauses.push(rootIndexNotInstalledExpr(parts.hasInstallJoin))
  }

  if (sidebarPage === 'filters') {
    addRootIndexPathPrefixClause(parts, rootPath, sanitizeStringArray(request.selectedWatchedFolders))
    const formats = sanitizeStringArray(request.selectedFormats).map((item) => item.toLowerCase())
    if (formats.length) {
      parts.clauses.push(`${rootIndexJsonTextExpr('format')} IN (${formats.map(() => '?').join(', ')})`)
      parts.params.push(...formats)
    }
    addRootIndexJsonArrayAnyClause(parts, 'scripts', sanitizeStringArray(request.selectedScripts))
    const category = String(request.selectedCategory || 'all')
    if (category !== 'all') parts.unsupportedReason = 'category filter needs derived category index'
  }

  if (sidebarPage === 'tags') {
    parts.unsupportedReason = 'local tag page needs local app database'
  }

  if (sidebarPage === 'sharedTags') {
    parts.unsupportedReason = 'shared tag page needs shared metadata overlay'
  }

  if (sidebarPage === 'folders') {
    const folderId = String(request.selectedFolderId || '').trim()
    if (folderId) {
      const prefix = rootRelativePrefixForFolder(rootPath, folderId)
      if (prefix === null) {
        parts.unsupportedReason = 'virtual folder filter needs fontFolderIds mapping'
      } else if (prefix) {
        addRootIndexPathPrefixClause(parts, rootPath, [folderId])
      }
    }
  }
}

function rootIndexOrderBy(request: FontQueryRequest, hasInstallJoin: boolean): string {
  const sortMode = request.sortMode || 'smart'
  const timeSortMode = request.timeSortMode || 'created'
  const fileName = `${rootIndexJsonTextExpr('fileName')} COLLATE NOCASE`
  const created = `COALESCE(entries.created_at, entries.modified_at, 0)`
  const modified = `COALESCE(entries.modified_at, 0)`
  if (sortMode === 'smart') {
    const time = timeSortMode === 'created' ? created : modified
    return `${rootIndexJsonBoolExpr('favorite')} DESC, ${rootIndexJsonBoolExpr('active')} DESC, ${rootIndexInstalledExpr(hasInstallJoin)} DESC, ${time} DESC, ${fileName} ASC, entries.relative_path ASC`
  }
  if (sortMode === 'nameAsc') return `${fileName} ASC, entries.relative_path ASC`
  if (sortMode === 'nameDesc') return `${fileName} DESC, entries.relative_path ASC`
  if (sortMode === 'createdDesc') return `${created} DESC, ${fileName} ASC, entries.relative_path ASC`
  if (sortMode === 'createdAsc') return `${created} ASC, ${fileName} ASC, entries.relative_path ASC`
  if (sortMode === 'modifiedDesc') return `${modified} DESC, ${fileName} ASC, entries.relative_path ASC`
  if (sortMode === 'modifiedAsc') return `${modified} ASC, ${fileName} ASC, entries.relative_path ASC`
  if (sortMode === 'sizeDesc') return `entries.file_size DESC, ${fileName} ASC, entries.relative_path ASC`
  if (sortMode === 'sizeAsc') return `entries.file_size ASC, ${fileName} ASC, entries.relative_path ASC`
  return `${fileName} ASC, entries.relative_path ASC`
}

export function buildRootIndexQuerySql(rootPath: string, request: FontQueryRequest, hasInstallJoin: boolean, limit: number, offset: number): RootIndexQuerySqlResult {
  const parts: RootIndexQueryParts = {
    clauses: [`COALESCE(entries.is_deleted, 0) = 0`, `entries.status = 'ok'`, `entries.font_json IS NOT NULL`, `json_valid(entries.font_json)`],
    params: [],
    hasInstallJoin,
    usedLike: false
  }
  addRootIndexKeywordClause(parts, String(request.keyword || ''))
  addRootIndexTimeRangeClause(parts, request.timeSortMode)
  if ((request.sidebarPage || 'library') === 'library') addRootIndexActiveFilterClauses(parts, request)
  addRootIndexPageFilterClauses(parts, rootPath, request)

  const joinSql = hasInstallJoin
    ? `LEFT JOIN install_db.install_status AS install_status ON install_status.font_id = ${rootIndexJsonExpr('id')}`
    : ''
  const where = parts.clauses.length ? `WHERE ${parts.clauses.join(' AND ')}` : ''
  const orderBy = rootIndexOrderBy(request, hasInstallJoin)
  const selectInstallColumns = hasInstallJoin ? `, install_status.installed AS installed, install_status.by_type AS installed_by, install_status.matches_json AS matches_json` : `, NULL AS installed, NULL AS installed_by, NULL AS matches_json`
  return {
    sql: `
      SELECT entries.relative_path, entries.cache_key, entries.file_size, entries.modified_at, entries.created_at, entries.status, entries.font_json, entries.message, entries.cached_at${selectInstallColumns}
      FROM entries
      ${joinSql}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `,
    countSql: `
      SELECT COUNT(*) AS count
      FROM entries
      ${joinSql}
      ${where}
    `,
    params: [...parts.params, limit, offset],
    countParams: [...parts.params],
    unsupportedReason: parts.unsupportedReason,
    usedLike: parts.usedLike
  }
}
