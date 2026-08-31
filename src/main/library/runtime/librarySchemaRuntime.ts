import type { FontItem } from "../../../shared/types";
import {
parseSqliteJson,
setSqliteMeta,
sqliteTableExists,
} from "../../db/sqliteHelpers";
import { fontToSqliteParams } from "../fontSqliteMapper";
import type { LibraryRuntimeOptions,SqliteDb } from "./libraryRuntimeTypes";

export function ensureStructuredFontsSchema(
  db: SqliteDb,
  ensureSqliteColumn: LibraryRuntimeOptions["ensureSqliteColumn"],
): void {
  const requiredColumns: Array<[string, string]> = [
    ["path", `TEXT NOT NULL DEFAULT ''`],
    ["file_name", `TEXT NOT NULL DEFAULT ''`],
    ["family", `TEXT NOT NULL DEFAULT ''`],
    ["full_name", `TEXT NOT NULL DEFAULT ''`],
    ["postscript_name", `TEXT NOT NULL DEFAULT ''`],
    ["style", `TEXT NOT NULL DEFAULT ''`],
    ["format", `TEXT NOT NULL DEFAULT 'unknown'`],
    ["scripts_json", `TEXT NOT NULL DEFAULT '[]'`],
    ["script_version", `INTEGER NOT NULL DEFAULT 0`],
    ["file_size", `INTEGER NOT NULL DEFAULT 0`],
    ["modified_at", `INTEGER NOT NULL DEFAULT 0`],
    ["created_at", "INTEGER"],
    ["added_at", `TEXT NOT NULL DEFAULT ''`],
    ["favorite", "INTEGER NOT NULL DEFAULT 0"],
    ["collection_ids_json", `TEXT NOT NULL DEFAULT '[]'`],
    ["tag_names_json", `TEXT NOT NULL DEFAULT '[]'`],
    ["system_installed", "INTEGER NOT NULL DEFAULT 0"],
    ["system_install_matches_json", `TEXT NOT NULL DEFAULT '[]'`],
    ["active", "INTEGER NOT NULL DEFAULT 0"],
    ["system_imported", "INTEGER NOT NULL DEFAULT 0"],
    ["preview_disabled", "INTEGER NOT NULL DEFAULT 0"],
    ["preview_error", "TEXT"],
    ["active_since", "TEXT"],
    ["managed_install_path", "TEXT"],
    ["managed_registry_name", "TEXT"],
    ["delete_protected", "INTEGER NOT NULL DEFAULT 0"],
    ["json", `TEXT NOT NULL DEFAULT '{}'`],
    ["updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"],
    ["deleted_at", "TEXT"],
  ];

  for (const [column, declaration] of requiredColumns) {
    ensureSqliteColumn(db, "fonts", column, declaration);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_fonts_path ON fonts(path);
    CREATE INDEX IF NOT EXISTS idx_fonts_file_name ON fonts(file_name);
    CREATE INDEX IF NOT EXISTS idx_fonts_family ON fonts(family);
    CREATE INDEX IF NOT EXISTS idx_fonts_full_name ON fonts(full_name);
    CREATE INDEX IF NOT EXISTS idx_fonts_postscript_name ON fonts(postscript_name);
    CREATE INDEX IF NOT EXISTS idx_fonts_format ON fonts(format);
    CREATE INDEX IF NOT EXISTS idx_fonts_favorite ON fonts(favorite);
    CREATE INDEX IF NOT EXISTS idx_fonts_system_installed ON fonts(system_installed);
    CREATE INDEX IF NOT EXISTS idx_fonts_active ON fonts(active);
    CREATE INDEX IF NOT EXISTS idx_fonts_system_imported ON fonts(system_imported);
    CREATE INDEX IF NOT EXISTS idx_fonts_delete_protected ON fonts(delete_protected);
    CREATE INDEX IF NOT EXISTS idx_fonts_modified_at ON fonts(modified_at);
    CREATE INDEX IF NOT EXISTS idx_fonts_created_at ON fonts(created_at);
    CREATE INDEX IF NOT EXISTS idx_fonts_file_size ON fonts(file_size);
    CREATE INDEX IF NOT EXISTS idx_fonts_deleted_at ON fonts(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_font_folder_ids_folder ON font_folder_ids(folder_id, font_id);
    CREATE INDEX IF NOT EXISTS idx_font_scripts_script ON font_scripts(script, font_id);
    CREATE INDEX IF NOT EXISTS idx_font_collections_collection ON font_collections(collection_id, font_id);
    CREATE INDEX IF NOT EXISTS idx_font_tags_tag ON font_tags(tag_name, font_id);
  `);
}

export function migrateLegacyFontJsonRows(
  db: SqliteDb,
  appendStartupLog: LibraryRuntimeOptions["appendStartupLog"],
): void {
  const migrated = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get("structuredFontsMigrated") as { value?: string } | undefined;
  if (migrated?.value === "1") return;

  if (!sqliteTableExists(db, "fonts")) {
    setSqliteMeta(db, "structuredFontsMigrated", "1");
    return;
  }

  const rows = db
    .prepare(
      `
    SELECT id, json
    FROM fonts
    WHERE deleted_at IS NULL
      AND json IS NOT NULL
      AND (path = '' OR file_name = '' OR family = '' OR full_name = '')
  `,
    )
    .all() as Array<{ id: string; json: string }>;

  if (!rows.length) {
    setSqliteMeta(db, "structuredFontsMigrated", "1");
    return;
  }

  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE fonts SET
      path = @path,
      file_name = @file_name,
      family = @family,
      full_name = @full_name,
      postscript_name = @postscript_name,
      style = @style,
      format = @format,
      scripts_json = @scripts_json,
      script_version = @script_version,
      file_size = @file_size,
      modified_at = @modified_at,
      created_at = @created_at,
      added_at = @added_at,
      favorite = @favorite,
      collection_ids_json = @collection_ids_json,
      tag_names_json = @tag_names_json,
      system_installed = @system_installed,
      system_install_matches_json = @system_install_matches_json,
      active = @active,
      system_imported = @system_imported,
      preview_disabled = @preview_disabled,
      preview_error = @preview_error,
      active_since = @active_since,
      managed_install_path = @managed_install_path,
      managed_registry_name = @managed_registry_name,
      delete_protected = @delete_protected,
      json = @json,
      updated_at = @updated_at
    WHERE id = @id
  `);

  const migrateRows = db.transaction(() => {
    for (const row of rows) {
      const font = parseSqliteJson<FontItem>(row.json, {
        id: row.id,
      } as FontItem);
      update.run(fontToSqliteParams(row.id, font, now));
    }
    setSqliteMeta(db, "structuredFontsMigrated", "1");
    setSqliteMeta(db, "structuredFontsMigratedAt", now);
  });
  migrateRows();
  appendStartupLog(`sqlite structured font migration finished: rows=${rows.length}`);
}

export function initializeLibraryDb(db: SqliteDb): void {
  // v2.0 stable architecture: local app.sqlite stores only software settings.
  // Font records, shared events, shared metrics and preview cache live in the watched font root.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS folders (
      path TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS folder_nodes (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tags (
      name TEXT PRIMARY KEY,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_font_tags (
      font_id TEXT NOT NULL,
      font_path TEXT NOT NULL DEFAULT '',
      tag_name TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(font_id, tag_name)
    );
  `);

  try {
    db.prepare("ALTER TABLE local_font_tags ADD COLUMN font_path TEXT NOT NULL DEFAULT ''").run();
  } catch {
    // Existing databases already have this column.
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_local_font_tags_tag ON local_font_tags(tag_name, font_id);
    CREATE INDEX IF NOT EXISTS idx_local_font_tags_path ON local_font_tags(font_path, tag_name);
    CREATE INDEX IF NOT EXISTS idx_local_font_tags_tag_path ON local_font_tags(tag_name, font_path);
  `);
  setSqliteMeta(db, "schemaVersion", "100");
  setSqliteMeta(db, "cacheArchitecture", "v1-clean-shared-root");
}

export function sqliteHasLibraryData(db: SqliteDb): boolean {
  const tables = [
    "fonts",
    "folders",
    "folder_nodes",
    "collections",
    "tags",
    "font_folder_ids",
  ];
  return tables.some(
    (table) =>
      sqliteTableExists(db, table) &&
      Number(
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count || 0,
      ) > 0,
  );
}
