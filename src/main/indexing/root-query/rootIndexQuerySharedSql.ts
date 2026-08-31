import { isAbsolute,relative,resolve } from 'node:path'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import type { RootIndexQueryParts } from './rootIndexQueryTypes'

export function sqliteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function rootIndexJsonExpr(field: string): string {
  return `json_extract(entries.font_json, '$.${field}')`
}

export function rootIndexJsonTextExpr(field: string): string {
  return `LOWER(COALESCE(${rootIndexJsonExpr(field)}, ''))`
}

export function rootIndexJsonBoolExpr(field: string): string {
  return `COALESCE(${rootIndexJsonExpr(field)}, 0)`
}

export function rootIndexRuntimeFontIdExpr(): string {
  return `LOWER(hfm_shared_font_id(COALESCE(NULLIF(entries.relative_path, ''), ${rootIndexJsonExpr('path')}, ''), entries.file_size, entries.modified_at))`
}

export function rootIndexRuntimePathExpr(): string {
  return `LOWER(REPLACE(COALESCE(NULLIF(entries.root_path, ''), '') || CASE WHEN COALESCE(NULLIF(entries.relative_path, ''), '') = '' THEN '' WHEN COALESCE(NULLIF(entries.root_path, ''), '') = '' THEN '' WHEN SUBSTR(COALESCE(entries.root_path, ''), -1) IN ('\\', '/') THEN '' ELSE '\\' END || COALESCE(entries.relative_path, ''), '/', '\\'))`
}

export function rootIndexLocalTagMatchExpr(alias = 'lft'): string {
  return `(LOWER(${alias}.font_id) = ${rootIndexJsonTextExpr('id')} OR LOWER(${alias}.font_id) = ${rootIndexRuntimeFontIdExpr()} OR (COALESCE(${alias}.font_path, '') <> '' AND LOWER(${alias}.font_path) = ${rootIndexRuntimePathExpr()}))`
}

export function rootIndexInstalledExpr(hasInstallJoin: boolean): string {
  return hasInstallJoin
    ? `(COALESCE(install_status.installed, ${rootIndexJsonBoolExpr('systemInstalled')}, 0) = 1 AND COALESCE(install_status.by_type, '') <> 'managed')`
    : `COALESCE(${rootIndexJsonBoolExpr('systemInstalled')}, 0)`
}

export function rootIndexNotInstalledExpr(hasInstallJoin: boolean): string {
  return hasInstallJoin
    ? `(install_status.font_id IS NOT NULL AND (COALESCE(install_status.installed, 0) = 0 OR COALESCE(install_status.by_type, 'none') = 'managed'))`
    : `0`
}

export function rootIndexActiveExpr(hasInstallJoin: boolean): string {
  return hasInstallJoin
    ? `(COALESCE(${rootIndexJsonBoolExpr('active')}, 0) = 1 OR COALESCE(install_status.by_type, 'none') IN ('managed', 'both'))`
    : `${rootIndexJsonBoolExpr('active')} = 1`
}

export function rootIndexSystemDefaultExpr(hasInstallJoin: boolean): string {
  const systemBase = `(COALESCE(${rootIndexJsonBoolExpr('systemImported')}, 0) = 1 OR ${rootIndexJsonTextExpr('path')} LIKE '%\\windows\\fonts\\%')`
  return hasInstallJoin ? `(COALESCE(install_status.system_default, 0) = 1 OR ${systemBase})` : systemBase
}

export function mergedIndexInstalledExpr(): string {
  return `(COALESCE(entries.installed, ${rootIndexJsonBoolExpr('systemInstalled')}, 0) = 1 AND COALESCE(entries.installed_by, '') <> 'managed')`
}

export function mergedIndexNotInstalledExpr(): string {
  return `(entries.installed IS NOT NULL AND (COALESCE(entries.installed, 0) = 0 OR COALESCE(entries.installed_by, 'none') = 'managed'))`
}

export function mergedIndexActiveExpr(): string {
  return `(COALESCE(${rootIndexJsonBoolExpr('active')}, 0) = 1 OR COALESCE(entries.installed_by, 'none') IN ('managed', 'both'))`
}

export function mergedIndexSystemDefaultExpr(): string {
  const systemBase = `(COALESCE(${rootIndexJsonBoolExpr('systemImported')}, 0) = 1 OR ${rootIndexJsonTextExpr('path')} LIKE '%\\windows\\fonts\\%')`
  return systemBase
}

export function sanitizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? Array.from(new Set(value.map((item) => String(item || '').trim()).filter(Boolean))) : []
}

export function escapeSqlLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export function normalizedFolderSqlLike(folder: string): string {
  return normalizePathForCacheCompare(folder)
}

export function escapedFolderSqlLikePrefix(folder: string): string {
  return `${escapeSqlLike(folder)}\\\\%`
}

export function timeRangeStartForSql(mode: string): number {
  const now = Date.now()
  const oneDay = 24 * 60 * 60 * 1000
  if (mode === 'today') {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today.getTime()
  }
  if (mode === '7d') return now - oneDay * 7
  if (mode === '30d') return now - oneDay * 30
  if (mode === '1y') return now - oneDay * 365
  return 0
}

function rootIndexJsonArrayEachExpr(field: string): string {
  return `json_each(CASE WHEN json_type(entries.font_json, '$.${field}') = 'array' THEN ${rootIndexJsonExpr(field)} ELSE '[]' END)`
}

export function rootIndexJsonArrayHasAnyValueExpr(field: string): string {
  return `EXISTS (SELECT 1 FROM ${rootIndexJsonArrayEachExpr(field)} AS hfm_json_item WHERE TRIM(CAST(hfm_json_item.value AS TEXT)) <> '')`
}

export function addRootIndexJsonArrayContainsClause(parts: RootIndexQueryParts, field: string, value: string): void {
  const clean = String(value || '').trim().toLowerCase()
  if (!clean) return
  parts.clauses.push(`EXISTS (SELECT 1 FROM ${rootIndexJsonArrayEachExpr(field)} AS hfm_json_item WHERE LOWER(TRIM(CAST(hfm_json_item.value AS TEXT))) = ?)` )
  parts.params.push(clean)
}

export function addRootIndexJsonArrayAnyClause(parts: RootIndexQueryParts, field: string, values: string[]): void {
  const cleanValues = sanitizeStringArray(values).map((item) => item.toLowerCase())
  if (!cleanValues.length) return
  parts.clauses.push(`EXISTS (SELECT 1 FROM ${rootIndexJsonArrayEachExpr(field)} AS hfm_json_item WHERE LOWER(TRIM(CAST(hfm_json_item.value AS TEXT))) IN (${cleanValues.map(() => '?').join(', ')}))`)
  parts.params.push(...cleanValues)
}

export function rootRelativePrefixForFolder(rootPath: string, folderPath: string): string | null {
  const clean = String(folderPath || '').trim()
  if (!clean) return ''
  if (!isAbsolute(clean) && !/^[a-zA-Z]:[\\/]/.test(clean) && !clean.startsWith('\\\\')) return null
  const root = normalizePathForCacheCompare(resolve(rootPath))
  const folder = normalizePathForCacheCompare(resolve(clean))
  if (folder === root) return ''
  if (!folder.startsWith(`${root}\\`)) return null
  const rel = relative(resolve(rootPath), resolve(clean)).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').toLowerCase()
  return rel || ''
}

export function addRootIndexPathPrefixClause(parts: RootIndexQueryParts, rootPath: string, folders: string[]): void {
  const cleanFolders = sanitizeStringArray(folders)
    .map((folder) => rootRelativePrefixForFolder(rootPath, folder))
    .filter((prefix): prefix is string => prefix !== null)
  if (!cleanFolders.length) {
    if (sanitizeStringArray(folders).length) parts.clauses.push('0')
    return
  }
  if (cleanFolders.includes('')) return
  const relExpr = 'LOWER(entries.relative_path)'
  const folderClauses: string[] = []
  for (const prefix of cleanFolders) {
    folderClauses.push(`(${relExpr} = ? OR ${relExpr} LIKE ? ESCAPE '\\')`)
    parts.params.push(prefix, `${escapeSqlLike(prefix)}/%`)
  }
  parts.clauses.push(`(${folderClauses.join(' OR ')})`)
}

export function addMergedIndexPathPrefixClause(parts: RootIndexQueryParts, folders: string[]): void {
  const cleanFolders = sanitizeStringArray(folders).map(normalizedFolderSqlLike).filter(Boolean)
  if (!cleanFolders.length) return

  const relativePathExpr = `LOWER(REPLACE(COALESCE(entries.relative_path, ''), '/', char(92)))`
  const rootPathExpr = `LOWER(REPLACE(COALESCE(entries.root_path, ''), '/', char(92)))`
  const runtimePathExpr = `CASE
    WHEN ${relativePathExpr} GLOB '[a-z]:\\*' OR ${relativePathExpr} LIKE '\\\\%' ESCAPE '\\' THEN ${relativePathExpr}
    WHEN ${relativePathExpr} = '' THEN ${rootPathExpr}
    ELSE ${rootPathExpr} || char(92) || ${relativePathExpr}
  END`
  const clauses: string[] = []
  for (const folder of cleanFolders) {
    clauses.push(`(${runtimePathExpr} = ? OR ${runtimePathExpr} LIKE ? ESCAPE '\\')`)
    parts.params.push(folder, escapedFolderSqlLikePrefix(folder))
  }
  parts.clauses.push(`(${clauses.join(' OR ')})`)
}

export function addRootIndexKeywordClause(parts: RootIndexQueryParts, keyword: string): void {
  const clean = String(keyword || '').trim().toLowerCase()
  if (!clean) return
  const fields = ['fileName', 'family', 'fullName', 'postscriptName', 'style', 'format', 'path']
  parts.clauses.push(`(${fields.map((field) => `${rootIndexJsonTextExpr(field)} LIKE ? ESCAPE '\\'`).join(' OR ')} OR LOWER(entries.relative_path) LIKE ? ESCAPE '\\')`)
  const like = `%${escapeSqlLike(clean)}%`
  parts.params.push(...fields.map(() => like), like)
  parts.usedLike = true
}

export function addRootIndexTimeRangeClause(parts: RootIndexQueryParts, mode?: string): void {
  const start = timeRangeStartForSql(String(mode || ''))
  if (!start) return
  parts.clauses.push(`COALESCE(entries.modified_at, entries.created_at, 0) >= ?`)
  parts.params.push(start)
}
