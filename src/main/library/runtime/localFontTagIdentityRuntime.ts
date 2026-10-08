import type { FontItem } from "../../../shared/types";

// Persisted local-tag identity, NOT a filesystem path. Legacy UNC keys contain
// one leading separator; changing this format would orphan existing bindings.
export function normalizeLocalTagFontPath(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
}

export function localTagFontPath(item: Pick<FontItem, "path"> | undefined): string {
  return normalizeLocalTagFontPath(item?.path);
}

// Bounded ordinary/extended storage aliases, never filesystem input or inferred
// mapped-drive aliases. A write uses them atomically, then stores its own spelling.
export function localTagFontReadPaths(value: unknown): string[] {
  const stored = normalizeLocalTagFontPath(value);
  const base = stored.replace(/^\\\?\\unc\\/, '\\').replace(/^\\\?\\(?=[a-z]:\\)/, '');
  const keys = new Set([stored, base]);
  if (/^\\[^\\?]+\\[^\\]+\\/.test(base)) keys.add('\\?\\unc' + base);
  else if (/^[a-z]:\\/.test(base)) keys.add('\\?\\' + base);
  return [...keys].filter(Boolean);
}

// SQL read equivalence does not confer filesystem authority on a stored key.
export function localTagPathCompareSql(expression: string): string {
  const path = `LTRIM(LOWER(REPLACE(TRIM(COALESCE(${expression}, '')), '/', char(92))), char(92))`;
  return `(CASE WHEN SUBSTR(${path}, 1, 6) = '?\\unc\\' THEN SUBSTR(${path}, 7) WHEN SUBSTR(${path}, 1, 2) = '?\\' THEN SUBSTR(${path}, 3) ELSE ${path} END)`;
}

// Build uncorrelated membership sets so SQLite normalizes tag paths once per
// statement, not once for every (font, binding) pair. Paths stay authoritative;
// only pathless legacy rows may fall back to a font ID.
export function localTagMembershipSql(pathExpression: string, idExpressions: string[], table: string, tagName?: string): { clause: string; params: string[] } {
  const tagFilter = tagName === undefined ? '' : ' AND lft.tag_name = ?';
  const paths = `SELECT ${localTagPathCompareSql('lft.font_path')} FROM ${table} lft WHERE COALESCE(lft.font_path, '') <> ''${tagFilter}`;
  const ids = `SELECT LOWER(lft.font_id) FROM ${table} lft WHERE COALESCE(lft.font_path, '') = ''${tagFilter}`;
  const clauses = [`${localTagPathCompareSql(pathExpression)} IN (${paths})`, ...idExpressions.map(id => `${id} IN (${ids})`)];
  return { clause: `(${clauses.join(' OR ')})`, params: tagName === undefined ? [] : clauses.map(() => tagName) };
}

export function localTagFontStorageId(item: Pick<FontItem, "id" | "sourceId"> & Partial<Pick<FontItem, "path">> | undefined): string {
  const path = item?.path ? localTagFontPath({ path: item.path }) : "";
  return path ? `local-path:${path}` : String(item?.id || "").trim() || String(item?.sourceId || "").trim();
}

export function localTagFontIdAliases(item: Pick<FontItem, "id" | "sourceId"> & Partial<Pick<FontItem, "path">> | undefined): string[] {
  const aliases = new Set<string>();
  for (const raw of [item?.id, item?.sourceId, localTagFontStorageId(item)]) {
    const id = String(raw || "").trim();
    if (id) aliases.add(id);
  }
  return Array.from(aliases);
}
