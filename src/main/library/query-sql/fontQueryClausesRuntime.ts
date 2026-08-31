import type { FontQueryRequest } from '@shared/types';
import { cleanSystemSqlExpression, systemMatchSqlExpression } from '../../install/windowsDefaultFonts';
import { addLegacyCollectionAnyClause,addLegacyCollectionContainsClause,isLegacyCollectionColumn } from '../legacy/legacyCollectionQueryRuntime';
import { escapeSqlLike, sanitizeStringArray, type FontQuerySqlParts } from './fontQuerySqlTypes';

function localFontTagMatchSql(alias = "lft"): string {
  return `(LOWER(${alias}.font_id) = LOWER(fonts.id) OR (COALESCE(${alias}.font_path, '') <> '' AND LOWER(${alias}.font_path) = LOWER(REPLACE(COALESCE(fonts.path, ''), '/', '\\'))))`;
}

function addJsonArrayContainsClause(
  parts: FontQuerySqlParts,
  column: string,
  value: string,
): void {
  if (!value) return;
  if (isLegacyCollectionColumn(column)) {
    addLegacyCollectionContainsClause(parts, value);
    return;
  }
  if (column === "fonts.tag_names_json") {
    parts.clauses.push(
      "EXISTS (SELECT 1 FROM font_tags ft WHERE ft.font_id = fonts.id AND ft.tag_name = ?)",
    );
    parts.params.push(value);
    return;
  }
  if (column === "fonts.scripts_json") {
    parts.clauses.push(
      "EXISTS (SELECT 1 FROM font_scripts fs WHERE fs.font_id = fonts.id AND fs.script = ?)",
    );
    parts.params.push(value);
    return;
  }
  parts.clauses.push(`${column} LIKE ? ESCAPE '\\'`);
  parts.params.push(`%${escapeSqlLike(JSON.stringify(value))}%`);
}

function addJsonArrayAnyClause(
  parts: FontQuerySqlParts,
  column: string,
  values: string[],
): void {
  const cleanValues = sanitizeStringArray(values);
  if (!cleanValues.length) return;
  if (column === "fonts.scripts_json") {
    parts.clauses.push(
      `EXISTS (SELECT 1 FROM font_scripts fs WHERE fs.font_id = fonts.id AND fs.script IN (${cleanValues.map(() => "?").join(", ")}))`,
    );
    parts.params.push(...cleanValues);
    return;
  }
  if (isLegacyCollectionColumn(column)) {
    addLegacyCollectionAnyClause(parts, cleanValues);
    return;
  }
  if (column === "fonts.tag_names_json") {
    parts.clauses.push(
      `EXISTS (SELECT 1 FROM font_tags ft WHERE ft.font_id = fonts.id AND ft.tag_name IN (${cleanValues.map(() => "?").join(", ")}))`,
    );
    parts.params.push(...cleanValues);
    return;
  }
  parts.clauses.push(
    `(${cleanValues.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})`,
  );
  for (const value of cleanValues)
    parts.params.push(`%${escapeSqlLike(JSON.stringify(value))}%`);
}

function normalizedFolderSqlLike(folder: string): string {
  return folder.replaceAll("/", "\\").replace(/\\+$/g, "").toLowerCase();
}

function escapedFolderSqlLikePrefix(folder: string): string {
  // With ESCAPE '\\', a literal path separator must be represented as two backslashes.
  // The trailing % must stay unescaped, otherwise selecting a watched root folder matches 0 children.
  return `${escapeSqlLike(folder)}\\\\%`;
}

function addPathPrefixClause(
  parts: FontQuerySqlParts,
  folders: string[],
): void {
  const cleanFolders = sanitizeStringArray(folders)
    .map(normalizedFolderSqlLike)
    .filter(Boolean);
  if (!cleanFolders.length) return;
  const pathExpr = `LOWER(REPLACE(fonts.path, '/', char(92)))`;
  const folderClauses: string[] = [];
  for (const folder of cleanFolders) {
    folderClauses.push(`(${pathExpr} = ? OR ${pathExpr} LIKE ? ESCAPE '\\')`);
    parts.params.push(folder, escapedFolderSqlLikePrefix(folder));
  }
  parts.clauses.push(`(${folderClauses.join(" OR ")})`);
}

function addSelectedFolderClause(
  parts: FontQuerySqlParts,
  folderId: string,
): void {
  const id = String(folderId || "").trim();
  if (!id) return;
  const pathExpr = `LOWER(REPLACE(fonts.path, '/', char(92)))`;
  const folder = normalizedFolderSqlLike(id);
  parts.clauses.push(
    `(EXISTS (SELECT 1 FROM font_folder_ids ffi WHERE ffi.font_id = fonts.id AND ffi.folder_id = ?) OR ${pathExpr} = ? OR ${pathExpr} LIKE ? ESCAPE '\\')`,
  );
  parts.params.push(id, folder, escapedFolderSqlLikePrefix(folder));
}

function addInClause(
  parts: FontQuerySqlParts,
  column: string,
  values: string[],
): void {
  const cleanValues = sanitizeStringArray(values);
  if (!cleanValues.length) return;
  parts.clauses.push(`${column} IN (${cleanValues.map(() => "?").join(", ")})`);
  parts.params.push(...cleanValues);
}

export function addKeywordClause(parts: FontQuerySqlParts, keyword: string): void {
  const clean = keyword.trim().toLowerCase();
  if (!clean) return;
  parts.clauses.push(`font_search.search_text LIKE ? ESCAPE '\\'`);
  parts.params.push(`%${escapeSqlLike(clean)}%`);
  parts.usedLike = true;
}

export function timeRangeStartForSql(mode: string): number {
  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;
  if (mode === "today") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today.getTime();
  }
  if (mode === "7d") return now - oneDay * 7;
  if (mode === "30d") return now - oneDay * 30;
  if (mode === "1y") return now - oneDay * 365;
  return 0;
}

export function addTimeRangeClause(parts: FontQuerySqlParts, mode?: string): void {
  const start = timeRangeStartForSql(String(mode || ""));
  if (!start) return;
  parts.clauses.push(
    `COALESCE(NULLIF(fonts.modified_at, 0), fonts.created_at, 0) >= ?`,
  );
  parts.params.push(start);
}

export function addActiveFilterClauses(
  parts: FontQuerySqlParts,
  request: FontQueryRequest,
): void {
  const filter = request.activeFilter || { kind: "all" };
  switch (filter.kind) {
    case "favorites":
      parts.clauses.push("fonts.favorite = 1");
      break;
    case "installed":
      parts.clauses.push(
        "(COALESCE(install_status.installed, fonts.system_installed) = 1 AND COALESCE(install_status.by_type, '') <> 'managed')",
      );
      break;
    case "notInstalled":
      parts.clauses.push(
        "(install_status.font_id IS NOT NULL AND (COALESCE(install_status.installed, 0) = 0 OR COALESCE(install_status.by_type, 'none') = 'managed'))",
      );
      break;
    case "active":
      parts.clauses.push("(fonts.active = 1 OR COALESCE(install_status.by_type, 'none') IN ('managed', 'both'))");
      break;
    case "systemBuiltin":
      parts.clauses.push(systemMatchSqlExpression());
      break;
    case "cleanSystem":
      parts.clauses.push(cleanSystemSqlExpression());
      break;
    case "format":
      addInClause(parts, "fonts.format", filter.id ? [filter.id] : []);
      break;
    case "script":
      addJsonArrayContainsClause(parts, "fonts.scripts_json", filter.id || "");
      break;
    case "collection":
      addLegacyCollectionContainsClause(parts, filter.id || "");
      break;
    case "tag":
      parts.clauses.push(
        `EXISTS (SELECT 1 FROM local_font_tags lft WHERE ${localFontTagMatchSql('lft')} AND lft.tag_name = ?)`,
      );
      parts.params.push(filter.name || "");
      break;
    case "sharedTag":
      addJsonArrayContainsClause(
        parts,
        "fonts.tag_names_json",
        filter.name || "",
      );
      break;
  }
}

export function addPageFilterClauses(
  parts: FontQuerySqlParts,
  request: FontQueryRequest,
): void {
  const sidebarPage = request.sidebarPage || "library";
  if (sidebarPage !== "library") {
    if (request.installStatus === "installed")
      parts.clauses.push(
        "(COALESCE(install_status.installed, fonts.system_installed) = 1 AND COALESCE(install_status.by_type, '') <> 'managed')",
      );
    if (request.installStatus === "notInstalled")
      parts.clauses.push(
        "(install_status.font_id IS NOT NULL AND (COALESCE(install_status.installed, 0) = 0 OR COALESCE(install_status.by_type, 'none') = 'managed'))",
      );
  }

  if (sidebarPage === "filters") {
    addPathPrefixClause(
      parts,
      sanitizeStringArray(request.selectedWatchedFolders),
    );
    addInClause(
      parts,
      "fonts.format",
      sanitizeStringArray(request.selectedFormats),
    );
    addJsonArrayAnyClause(
      parts,
      "fonts.scripts_json",
      sanitizeStringArray(request.selectedScripts),
    );
    const category = String(request.selectedCategory || "all");
    if (category !== "all") {
      parts.clauses.push("font_search.category = ?");
      parts.params.push(category);
    }
  }

  if (sidebarPage === "tags") {
    const tagName = String(request.selectedTagName || "").trim();
    if (tagName) {
      parts.clauses.push(
        `EXISTS (SELECT 1 FROM local_font_tags lft WHERE ${localFontTagMatchSql('lft')} AND lft.tag_name = ?)`,
      );
      parts.params.push(tagName);
    } else {
      parts.clauses.push(
        `EXISTS (SELECT 1 FROM local_font_tags lft WHERE ${localFontTagMatchSql('lft')})`,
      );
    }
  }

  if (sidebarPage === "sharedTags") {
    const tagName = String(request.selectedTagName || "").trim();
    if (tagName)
      addJsonArrayContainsClause(parts, "fonts.tag_names_json", tagName);
    else
      parts.clauses.push(
        "EXISTS (SELECT 1 FROM font_tags ft WHERE ft.font_id = fonts.id)",
      );
  }

  if (sidebarPage === "folders") {
    const folderId = String(request.selectedFolderId || "").trim();
    if (folderId) addSelectedFolderClause(parts, folderId);
    else
      parts.clauses.push(
        `(EXISTS (SELECT 1 FROM font_folder_ids ffi WHERE ffi.font_id = fonts.id) OR fonts.system_imported = 0)`,
      );
  }
}
