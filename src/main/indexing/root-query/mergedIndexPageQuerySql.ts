import { isAbsolute } from 'node:path'
import type { FontQueryRequest } from '../../../shared/types'
import {
addMergedIndexPathPrefixClause,
addRootIndexJsonArrayAnyClause,
addRootIndexJsonArrayContainsClause,
addRootIndexTimeRangeClause,
mergedIndexActiveExpr,
mergedIndexInstalledExpr,
mergedIndexNotInstalledExpr,
mergedIndexSystemDefaultExpr,
rootIndexJsonBoolExpr,
rootIndexJsonTextExpr,
rootIndexJsonArrayHasAnyValueExpr,
rootIndexLocalTagMatchExpr,
rootIndexRuntimeFontIdExpr,
sanitizeStringArray,
} from './rootIndexQuerySharedSql'
import { addLegacyRootIndexCollectionContainsClause } from './legacy/legacyCollectionRootQueryRuntime'
import type { RootIndexQueryParts,RootIndexQuerySqlResult } from './rootIndexQueryTypes'


function escapeMergedIndexSearchLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function addMergedIndexKeywordClause(parts: RootIndexQueryParts, keyword: string): void {
  const clean = String(keyword || '').trim().toLowerCase()
  if (!clean) return
  parts.clauses.push(`LOWER(COALESCE(entries.search_text, '')) LIKE ? ESCAPE '\\'`)
  parts.params.push(`%${escapeMergedIndexSearchLike(clean)}%`)
  parts.usedLike = true
}

function addMergedIndexActiveFilterClauses(parts: RootIndexQueryParts, request: FontQueryRequest): void {
  const filter = request.activeFilter || { kind: 'all' }
  switch (filter.kind) {
    case 'favorites':
      parts.clauses.push(`${rootIndexJsonBoolExpr('favorite')} = 1`)
      break
    case 'installed':
      parts.clauses.push(mergedIndexInstalledExpr())
      break
    case 'notInstalled':
      parts.clauses.push(mergedIndexNotInstalledExpr())
      break
    case 'active':
      parts.clauses.push(mergedIndexActiveExpr())
      break
    case 'systemBuiltin':
    case 'cleanSystem':
      parts.clauses.push(mergedIndexSystemDefaultExpr())
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
      if (filter.name) {
        parts.clauses.push(`EXISTS (SELECT 1 FROM local_db.local_font_tags lft WHERE ${rootIndexLocalTagMatchExpr('lft')} AND lft.tag_name = ?)` )
        parts.params.push(filter.name)
      }
      break
    case 'sharedTag':
      addRootIndexJsonArrayContainsClause(parts, 'tagNames', filter.name || '')
      break
  }
}

function addMergedIndexPageFilterClauses(parts: RootIndexQueryParts, request: FontQueryRequest): void {
  const sidebarPage = request.sidebarPage || 'library'
  if (sidebarPage !== 'library') {
    if (request.installStatus === 'installed') parts.clauses.push(mergedIndexInstalledExpr())
    if (request.installStatus === 'notInstalled') parts.clauses.push(mergedIndexNotInstalledExpr())
  }

  if (sidebarPage === 'filters') {
    addMergedIndexPathPrefixClause(parts, sanitizeStringArray(request.selectedWatchedFolders))
    const formats = sanitizeStringArray(request.selectedFormats).map((item) => item.toLowerCase())
    if (formats.length) {
      parts.clauses.push(`${rootIndexJsonTextExpr('format')} IN (${formats.map(() => '?').join(', ')})`)
      parts.params.push(...formats)
    }
    addRootIndexJsonArrayAnyClause(parts, 'scripts', sanitizeStringArray(request.selectedScripts))
    const category = String(request.selectedCategory || 'all')
    if (category !== 'all') {
      parts.clauses.push('entries.category_index = ?')
      parts.params.push(category)
    }
  }

  if (sidebarPage === 'tags') {
    const tagName = String(request.selectedTagName || '').trim()
    if (tagName) {
      parts.clauses.push(`EXISTS (SELECT 1 FROM local_db.local_font_tags lft WHERE ${rootIndexLocalTagMatchExpr('lft')} AND lft.tag_name = ?)` )
      parts.params.push(tagName)
    } else {
      parts.clauses.push(`EXISTS (SELECT 1 FROM local_db.local_font_tags lft WHERE ${rootIndexLocalTagMatchExpr('lft')})`)
    }
  }

  if (sidebarPage === 'sharedTags') {
    const tagName = String(request.selectedTagName || '').trim()
    if (tagName) addRootIndexJsonArrayContainsClause(parts, 'tagNames', tagName)
    else parts.clauses.push(rootIndexJsonArrayHasAnyValueExpr('tagNames'))
  }

  if (sidebarPage === 'folders') {
    const folderId = String(request.selectedFolderId || '').trim()
    if (folderId) {
      if (isAbsolute(folderId) || /^[a-zA-Z]:[\\/]/.test(folderId) || folderId.startsWith('\\\\')) addMergedIndexPathPrefixClause(parts, [folderId])
      else parts.unsupportedReason = 'virtual folder filter needs fontFolderIds mapping'
    }
  }
}

function mergedIndexOrderBy(request: FontQueryRequest): string {
  const sortMode = request.sortMode || 'smart'
  const timeSortMode = request.timeSortMode || 'created'
  const fileName = `${rootIndexJsonTextExpr('fileName')} COLLATE NOCASE`
  const created = `COALESCE(entries.created_at, entries.modified_at, 0)`
  const modified = `COALESCE(entries.modified_at, 0)`
  const stable = 'entries.root_path ASC, entries.relative_path ASC'
  if (sortMode === 'smart') {
    const time = timeSortMode === 'created' ? created : modified
    return `${rootIndexJsonBoolExpr('favorite')} DESC, ${rootIndexJsonBoolExpr('active')} DESC, ${mergedIndexInstalledExpr()} DESC, ${time} DESC, ${fileName} ASC, ${stable}`
  }
  if (sortMode === 'nameAsc') return `${fileName} ASC, ${stable}`
  if (sortMode === 'nameDesc') return `${fileName} DESC, ${stable}`
  if (sortMode === 'createdDesc') return `${created} DESC, ${fileName} ASC, ${stable}`
  if (sortMode === 'createdAsc') return `${created} ASC, ${fileName} ASC, ${stable}`
  if (sortMode === 'modifiedDesc') return `${modified} DESC, ${fileName} ASC, ${stable}`
  if (sortMode === 'modifiedAsc') return `${modified} ASC, ${fileName} ASC, ${stable}`
  if (sortMode === 'sizeDesc') return `entries.file_size DESC, ${fileName} ASC, ${stable}`
  if (sortMode === 'sizeAsc') return `entries.file_size ASC, ${fileName} ASC, ${stable}`
  return `${fileName} ASC, ${stable}`
}


export function buildMergedIndexIdsQuerySql(request: FontQueryRequest, limit: number): Omit<RootIndexQuerySqlResult, 'countSql' | 'countParams'> {
  const parts: RootIndexQueryParts = {
    clauses: [`COALESCE(entries.is_deleted, 0) = 0`, `entries.status = 'ok'`, `entries.font_json IS NOT NULL`, `json_valid(entries.font_json)`],
    params: [],
    hasInstallJoin: false,
    usedLike: false
  }
  addMergedIndexKeywordClause(parts, String(request.keyword || ''))
  addRootIndexTimeRangeClause(parts, request.timeSortMode)
  if ((request.sidebarPage || 'library') === 'library') addMergedIndexActiveFilterClauses(parts, request)
  addMergedIndexPageFilterClauses(parts, request)

  const where = parts.clauses.length ? `WHERE ${parts.clauses.join(' AND ')}` : ''
  const orderBy = mergedIndexOrderBy(request)
  return {
    sql: `
      SELECT ${rootIndexRuntimeFontIdExpr()} AS id
      FROM entries
      ${where}
      ORDER BY ${orderBy}
      LIMIT ?
    `,
    params: [...parts.params, Math.max(1, limit)],
    unsupportedReason: parts.unsupportedReason,
    usedLike: parts.usedLike
  }
}

export function buildMergedIndexQuerySql(request: FontQueryRequest, limit: number, offset: number): RootIndexQuerySqlResult {
  const parts: RootIndexQueryParts = {
    clauses: [`COALESCE(entries.is_deleted, 0) = 0`, `entries.status = 'ok'`, `entries.font_json IS NOT NULL`, `json_valid(entries.font_json)`],
    params: [],
    hasInstallJoin: false,
    usedLike: false
  }
  addMergedIndexKeywordClause(parts, String(request.keyword || ''))
  addRootIndexTimeRangeClause(parts, request.timeSortMode)
  if ((request.sidebarPage || 'library') === 'library') addMergedIndexActiveFilterClauses(parts, request)
  addMergedIndexPageFilterClauses(parts, request)

  const where = parts.clauses.length ? `WHERE ${parts.clauses.join(' AND ')}` : ''
  const orderBy = mergedIndexOrderBy(request)
  return {
    sql: `
      SELECT entries.root_path, entries.relative_path, entries.cache_key, entries.file_size, entries.modified_at, entries.created_at,
             entries.status, entries.font_json, entries.message, entries.cached_at, entries.installed, entries.installed_by, entries.matches_json
      FROM entries
      ${where}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `,
    countSql: `
      SELECT COUNT(*) AS count
      FROM entries
      ${where}
    `,
    params: [...parts.params, limit, offset],
    countParams: [...parts.params],
    unsupportedReason: parts.unsupportedReason,
    usedLike: parts.usedLike
  }
}
