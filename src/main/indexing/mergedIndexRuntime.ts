import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import { dirname, resolve } from "node:path";
import type { FontIndexChangePayload } from "../../shared/types";
import { normalizePathForCacheCompare } from "../path/cachePath";
import { inferMergedIndexCategoryFromJson } from "./merged-page/mergedIndexCategoryRuntime";
import { buildMergedIndexSearchTextFromJson } from "./merged-page/mergedIndexSearchTextRuntime";
import type { MergedIndexPageRow } from "./rootIndexQuerySql";

export type MergedIndexSourceInfo = {
  root: string;
  indexDbPath: string;
  installDbPath?: string;
  indexSignature: string;
  installSignature: string;
  sharedMetadataSignature: string;
};

type OpenRootIndexDb = (
  filePath: string,
  rootPath: string,
  storage: "root" | "fallback",
  touchMeta?: boolean,
) => Promise<any>;

type MergedIndexRuntimeDeps = {
  dataPath: (...segments: string[]) => string;
  exists: (filePath: string) => Promise<boolean>;
  openStableSqliteDb: (filePath: string, label: string) => any;
  openRootIndexDb: OpenRootIndexDb;
  closeSqliteDb: (db: any) => void;
  getSqliteMeta: (db: any, key: string, fallback?: string) => string;
  setSqliteMeta: (db: any, key: string, value: string) => void;
  sqliteTableExists: (db: any, tableName: string) => boolean;
  appendStartupLog: (line: string) => void;
  schemaVersion: number;
  staleFirstPageEnabled: boolean;
};

export function createMergedIndexRuntime(deps: MergedIndexRuntimeDeps) {
  function mergedIndexDbPath(): string {
    return deps.dataPath("db", "merged-index.sqlite");
  }

  function sharedFontId(
    cacheIdentity: unknown,
    size: unknown,
    mtimeMs: unknown,
  ): string {
    const signature = `${String(cacheIdentity || "").toLowerCase()}|${Number(size || 0)}|${Math.round(Number(mtimeMs || 0))}`;
    return createHash("sha1").update(signature).digest("hex");
  }

  function registerMergedIndexSqlFunctions(db: any): void {
    try {
      db.function(
        "hfm_shared_font_id",
        { deterministic: true },
        (cacheIdentity: unknown, size: unknown, mtimeMs: unknown) =>
          sharedFontId(cacheIdentity, size, mtimeMs),
      );
    } catch {
      // Function may already be registered on a reused SQLite handle.
    }
  }

  async function fileStatSignature(filePath: string): Promise<string> {
    try {
      const stat = await fsp.stat(filePath);
      return `${Math.round(stat.mtimeMs)}:${stat.size}`;
    } catch {
      return "missing";
    }
  }

  async function rootIndexContentSignature(
    indexDbPath: string,
    rootPath: string,
  ): Promise<string> {
    if (!(await deps.exists(indexDbPath))) return "missing";
    const db = await deps.openRootIndexDb(indexDbPath, rootPath, "root", false);
    try {
      const metaUpdatedAt = deps.getSqliteMeta(db, "updatedAt");
      const cacheVersion =
        deps.getSqliteMeta(db, "cacheVersion") ||
        deps.getSqliteMeta(db, "index_version");
      const schemaVersion =
        deps.getSqliteMeta(db, "schemaVersion") ||
        deps.getSqliteMeta(db, "schema_version");
      const row = db
        .prepare(
          `
        SELECT COUNT(*) AS count,
               COALESCE(MAX(opstamp), 0) AS max_opstamp,
               COALESCE(MAX(revision), 0) AS max_revision,
               COALESCE(MAX(cached_at), '') AS max_cached_at
        FROM entries
        WHERE COALESCE(is_deleted, 0) = 0 AND status = 'ok' AND font_json IS NOT NULL AND json_valid(font_json)
      `,
        )
        .get() as
        | {
            count?: number;
            max_opstamp?: number;
            max_revision?: number;
            max_cached_at?: string;
          }
        | undefined;
      return [
        "root-v3",
        schemaVersion || "0",
        cacheVersion || "0",
        metaUpdatedAt || "",
        Number(row?.count || 0),
        Number(row?.max_opstamp || 0),
        Number(row?.max_revision || 0),
        String(row?.max_cached_at || ""),
      ].join("|");
    } catch (error) {
      deps.appendStartupLog(
        `local merged index root signature fallback: ${indexDbPath}, ${error instanceof Error ? error.message : String(error)}`,
      );
      return `stat:${await fileStatSignature(indexDbPath)}`;
    } finally {
      deps.closeSqliteDb(db);
    }
  }

  async function installStatusContentSignature(
    installDbPath: string | undefined,
  ): Promise<string> {
    if (!installDbPath || !(await deps.exists(installDbPath))) return "none";
    const db = deps.openStableSqliteDb(installDbPath, "install-signature");
    try {
      if (!deps.sqliteTableExists(db, "install_status")) return "missing-table";
      const checkedAt = deps.getSqliteMeta(db, "installedTotalCheckedAt");
      const total = deps.getSqliteMeta(db, "installedTotalCount");
      const row = db
        .prepare(
          `
        SELECT COUNT(*) AS count,
               COALESCE(SUM(CASE WHEN installed = 1 AND by_type <> 'managed' THEN 1 ELSE 0 END), 0) AS installed_count,
               COALESCE(SUM(CASE WHEN by_type IN ('managed', 'both') THEN 1 ELSE 0 END), 0) AS active_count,
               COALESCE(MAX(checked_at), '') AS max_checked_at
        FROM install_status
      `,
        )
        .get() as
        | { count?: number; installed_count?: number; max_checked_at?: string }
        | undefined;
      return [
        "install-v2",
        checkedAt || "",
        total || "",
        Number(row?.count || 0),
        Number(row?.installed_count || 0),
        Number((row as any)?.active_count || 0),
        String(row?.max_checked_at || ""),
      ].join("|");
    } catch (error) {
      deps.appendStartupLog(
        `local merged index install signature fallback: ${installDbPath}, ${error instanceof Error ? error.message : String(error)}`,
      );
      return `stat:${await fileStatSignature(installDbPath)}`;
    } finally {
      deps.closeSqliteDb(db);
    }
  }

  function sqliteTableColumns(db: any, tableName: string): Set<string> {
    try {
      return new Set(
        (
          db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
            name: string;
          }>
        ).map((column) => column.name),
      );
    } catch {
      return new Set();
    }
  }

  function hasColumns(db: any, tableName: string, columns: string[]): boolean {
    const existing = sqliteTableColumns(db, tableName);
    return columns.every((column) => existing.has(column));
  }

  function addColumnIfMissing(
    db: any,
    tableName: string,
    columns: Set<string>,
    name: string,
    definition: string,
  ): boolean {
    if (columns.has(name)) return false;
    db.prepare(
      `ALTER TABLE ${tableName} ADD COLUMN ${name} ${definition}`,
    ).run();
    columns.add(name);
    return true;
  }

  function initializeMergedIndexDb(db: any): void {
    let invalidated = false;
    const previousSchemaVersion =
      deps.getSqliteMeta(db, "schemaVersion") ||
      deps.getSqliteMeta(db, "schema_version") ||
      "0";
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const requiredSourceColumns = [
      "root_path",
      "index_db_path",
      "index_signature",
      "install_signature",
      "synced_at",
    ];
    const requiredEntryColumns = [
      "root_path",
      "relative_path",
      "cache_key",
      "file_size",
      "modified_at",
      "status",
      "font_json",
      "cached_at",
    ];
    if (
      deps.sqliteTableExists(db, "sources") &&
      !hasColumns(db, "sources", requiredSourceColumns)
    ) {
      db.exec("DROP TABLE IF EXISTS sources;");
      invalidated = true;
      deps.appendStartupLog(
        "sqlite schema self-heal: reset merged-index.sources due to incompatible columns",
      );
    }
    if (
      deps.sqliteTableExists(db, "entries") &&
      !hasColumns(db, "entries", requiredEntryColumns)
    ) {
      db.exec("DROP TABLE IF EXISTS entries;");
      invalidated = true;
      deps.appendStartupLog(
        "sqlite schema self-heal: reset merged-index.entries due to incompatible columns",
      );
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        root_path TEXT PRIMARY KEY,
        index_db_path TEXT NOT NULL,
        install_db_path TEXT,
        index_signature TEXT NOT NULL,
        install_signature TEXT NOT NULL,
        shared_metadata_signature TEXT NOT NULL DEFAULT 'metadata:none',
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entries (
        root_path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        cache_key TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        modified_at REAL NOT NULL,
        created_at REAL,
        status TEXT NOT NULL,
        font_json TEXT,
        message TEXT,
        cached_at TEXT NOT NULL,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        installed INTEGER,
        installed_by TEXT,
        matches_json TEXT,
        category_index TEXT,
        search_text TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (root_path, relative_path)
      );
    `);

    const sourceColumns = sqliteTableColumns(db, "sources");
    invalidated =
      addColumnIfMissing(
        db,
        "sources",
        sourceColumns,
        "install_db_path",
        "TEXT",
      ) || invalidated;
    invalidated =
      addColumnIfMissing(
        db,
        "sources",
        sourceColumns,
        "install_signature",
        `TEXT NOT NULL DEFAULT 'none'`,
      ) || invalidated;
    invalidated =
      addColumnIfMissing(
        db,
        "sources",
        sourceColumns,
        "shared_metadata_signature",
        `TEXT NOT NULL DEFAULT 'metadata:none'`,
      ) || invalidated;
    invalidated =
      addColumnIfMissing(
        db,
        "sources",
        sourceColumns,
        "synced_at",
        `TEXT NOT NULL DEFAULT ''`,
      ) || invalidated;

    const entryColumns = sqliteTableColumns(db, "entries");
    invalidated =
      addColumnIfMissing(db, "entries", entryColumns, "created_at", "REAL") ||
      invalidated;
    invalidated =
      addColumnIfMissing(db, "entries", entryColumns, "message", "TEXT") ||
      invalidated;
    invalidated =
      addColumnIfMissing(
        db,
        "entries",
        entryColumns,
        "is_deleted",
        "INTEGER NOT NULL DEFAULT 0",
      ) || invalidated;
    invalidated =
      addColumnIfMissing(db, "entries", entryColumns, "installed", "INTEGER") ||
      invalidated;
    const addedInstalledBy = addColumnIfMissing(
      db,
      "entries",
      entryColumns,
      "installed_by",
      "TEXT",
    );
    invalidated = addedInstalledBy || invalidated;
    invalidated =
      addColumnIfMissing(db, "entries", entryColumns, "matches_json", "TEXT") ||
      invalidated;
    invalidated =
      addColumnIfMissing(
        db,
        "entries",
        entryColumns,
        "category_index",
        "TEXT",
      ) || invalidated;
    invalidated =
      addColumnIfMissing(
        db,
        "entries",
        entryColumns,
        "search_text",
        `TEXT NOT NULL DEFAULT ''`,
      ) || invalidated;

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_merged_entries_status ON entries(status, is_deleted);
      CREATE INDEX IF NOT EXISTS idx_merged_entries_modified ON entries(modified_at);
      CREATE INDEX IF NOT EXISTS idx_merged_entries_size ON entries(file_size);
      CREATE INDEX IF NOT EXISTS idx_merged_entries_root ON entries(root_path);
      CREATE INDEX IF NOT EXISTS idx_merged_entries_installed ON entries(installed);
      CREATE INDEX IF NOT EXISTS idx_merged_entries_installed_by ON entries(installed_by);
      CREATE INDEX IF NOT EXISTS idx_merged_entries_category ON entries(category_index);
      CREATE INDEX IF NOT EXISTS idx_merged_entries_search_text ON entries(search_text);
    `);

    if (previousSchemaVersion !== String(deps.schemaVersion) || invalidated) {
      deps.setSqliteMeta(db, "sourcesKey", "");
      deps.setSqliteMeta(db, "schemaMigratedAt", new Date().toISOString());
      deps.appendStartupLog(
        `sqlite schema self-heal: merged-index schema ready ${previousSchemaVersion || "0"} -> ${deps.schemaVersion}, invalidated=${invalidated}`,
      );
    }
    deps.setSqliteMeta(db, "schemaVersion", String(deps.schemaVersion));
    deps.setSqliteMeta(db, "cacheArchitecture", "local-derived-merged-index");
  }

  function mergedIndexRequiredSchemaUsable(db: any): boolean {
    if (
      !deps.sqliteTableExists(db, "sources") ||
      !deps.sqliteTableExists(db, "entries")
    )
      return false;
    return (
      hasColumns(db, "sources", [
        "root_path",
        "index_db_path",
        "install_db_path",
        "index_signature",
        "install_signature",
        "shared_metadata_signature",
        "synced_at",
      ]) &&
      hasColumns(db, "entries", [
        "root_path",
        "relative_path",
        "cache_key",
        "file_size",
        "modified_at",
        "created_at",
        "status",
        "font_json",
        "message",
        "cached_at",
        "is_deleted",
        "installed",
        "installed_by",
        "matches_json",
        "category_index",
        "search_text",
      ])
    );
  }

  async function openMergedIndexDb(): Promise<any> {
    await fsp.mkdir(dirname(mergedIndexDbPath()), { recursive: true });
    const db = deps.openStableSqliteDb(mergedIndexDbPath(), "merged-index");
    registerMergedIndexSqlFunctions(db);
    initializeMergedIndexDb(db);
    return db;
  }

  function mergedIndexSourcesKey(sources: MergedIndexSourceInfo[]): string {
    return JSON.stringify(
      sources
        .map((source) => ({
          root: normalizePathForCacheCompare(source.root),
          indexDbPath: normalizePathForCacheCompare(source.indexDbPath),
          installDbPath: source.installDbPath
            ? normalizePathForCacheCompare(source.installDbPath)
            : "",
          indexSignature: source.indexSignature,
          installSignature: source.installSignature,
          sharedMetadataSignature:
            source.sharedMetadataSignature || "metadata:none",
        }))
        .sort((a, b) => a.root.localeCompare(b.root)),
    );
  }

  function mergedIndexRootsKey(roots: string[]): string {
    return JSON.stringify(
      Array.from(
        new Set(
          roots.map((root) => normalizePathForCacheCompare(resolve(root))),
        ),
      ).sort(),
    );
  }

  function mergedIndexLocalSnapshotUsable(db: any, roots: string[]): boolean {
    if (!deps.staleFirstPageEnabled) return false;
    try {
      const schemaVersion = deps.getSqliteMeta(db, "schemaVersion");
      if (schemaVersion !== String(deps.schemaVersion)) return false;
      if (!mergedIndexRequiredSchemaUsable(db)) return false;
      const expected = JSON.parse(mergedIndexRootsKey(roots)) as string[];
      const sourceRows = db
        .prepare("SELECT root_path FROM sources ORDER BY root_path")
        .all() as Array<{ root_path?: string }>;
      const actual = Array.from(
        new Set(
          sourceRows
            .map((row) => normalizePathForCacheCompare(row.root_path || ""))
            .filter(Boolean),
        ),
      ).sort();
      if (expected.length !== actual.length) return false;
      for (let i = 0; i < expected.length; i += 1) {
        if (expected[i] !== actual[i]) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function mergedIndexInsertStatement(db: any): any {
    return db.prepare(`
      INSERT OR REPLACE INTO entries (
        root_path, relative_path, cache_key, file_size, modified_at, created_at, status, font_json, message, cached_at,
        is_deleted, installed, installed_by, matches_json, category_index, search_text
      ) VALUES (
        @root_path, @relative_path, @cache_key, @file_size, @modified_at, @created_at, @status, @font_json, @message, @cached_at,
        @is_deleted, @installed, @installed_by, @matches_json, @category_index, @search_text
      )
    `);
  }

  function writeMergedIndexSourceRow(
    db: any,
    source: MergedIndexSourceInfo,
    syncedAt: string,
  ): void {
    db.prepare(
      `
      INSERT OR REPLACE INTO sources (root_path, index_db_path, install_db_path, index_signature, install_signature, shared_metadata_signature, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run(
      source.root,
      source.indexDbPath,
      source.installDbPath || null,
      source.indexSignature,
      source.installSignature,
      source.sharedMetadataSignature || "metadata:none",
      syncedAt,
    );
  }

  function bindMergedIndexRow(
    row: MergedIndexPageRow,
    fallbackRoot: string,
    now: string,
  ): Record<string, unknown> {
    return {
      root_path: row.root_path || fallbackRoot,
      relative_path: row.relative_path,
      cache_key: row.cache_key,
      file_size: Number(row.file_size || 0),
      modified_at: Number(row.modified_at || 0),
      created_at:
        row.created_at === null || row.created_at === undefined
          ? null
          : Number(row.created_at),
      status: row.status,
      font_json: row.font_json || null,
      message: row.message || null,
      cached_at: row.cached_at || now,
      is_deleted: 0,
      installed:
        row.installed === null || row.installed === undefined
          ? null
          : Number(row.installed ? 1 : 0),
      installed_by: row.installed_by || null,
      matches_json: row.matches_json || null,
      category_index:
        row.category_index || inferMergedIndexCategoryFromJson(row.font_json),
      search_text:
        row.search_text ||
        buildMergedIndexSearchTextFromJson(row.font_json, {
          rootPath: row.root_path || fallbackRoot,
          relativePath: row.relative_path,
          category:
            row.category_index ||
            inferMergedIndexCategoryFromJson(row.font_json),
        }),
    };
  }

  function ensureMergedIndexPendingSnapshotForRoots(
    db: any,
    roots: string[],
  ): void {
    const normalizedRoots = Array.from(
      new Set((roots || []).map((root) => resolve(root)).filter(Boolean)),
    ).sort();
    if (!normalizedRoots.length) return;
    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare("DELETE FROM entries").run();
      db.prepare("DELETE FROM sources").run();
      const insertSource = db.prepare(`
        INSERT OR REPLACE INTO sources (root_path, index_db_path, install_db_path, index_signature, install_signature, shared_metadata_signature, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const root of normalizedRoots) {
        insertSource.run(
          root,
          "",
          null,
          "pending-snapshot",
          "pending-snapshot",
          "metadata:pending-snapshot",
          now,
        );
      }
    });
    tx();
    deps.setSqliteMeta(
      db,
      "sourcesKey",
      `pending:${mergedIndexRootsKey(normalizedRoots)}`,
    );
    deps.setSqliteMeta(db, "pendingSnapshotAt", now);
  }

  function mergedIndexSourcesMatchRoots(db: any, roots: string[]): boolean {
    try {
      const expected = JSON.parse(mergedIndexRootsKey(roots)) as string[];
      const sourceRows = db
        .prepare("SELECT root_path FROM sources ORDER BY root_path")
        .all() as Array<{ root_path?: string }>;
      const actual = Array.from(
        new Set(
          sourceRows
            .map((row) => normalizePathForCacheCompare(row.root_path || ""))
            .filter(Boolean),
        ),
      ).sort();
      if (expected.length !== actual.length) return false;
      for (let i = 0; i < expected.length; i += 1) {
        if (expected[i] !== actual[i]) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  function relativePathsFromFontIndexPayload(
    rootPath: string,
    payload: FontIndexChangePayload,
    cacheKeyForRootFile: (rootPath: string, filePath: string) => string,
    pathInsideFolder: (candidatePath: string, folderPath: string) => boolean,
  ): string[] {
    const relativePaths = new Set<string>();
    for (const item of payload.upserts || []) {
      if (item?.path && pathInsideFolder(item.path, rootPath))
        relativePaths.add(
          cacheKeyForRootFile(rootPath, item.path).replaceAll("\\", "/"),
        );
    }
    for (const item of payload.deletes || []) {
      if (item?.relativePath)
        relativePaths.add(String(item.relativePath).replaceAll("\\", "/"));
    }
    return Array.from(relativePaths);
  }

  return {
    mergedIndexDbPath,
    fileStatSignature,
    rootIndexContentSignature,
    installStatusContentSignature,
    openMergedIndexDb,
    mergedIndexSourcesKey,
    mergedIndexRootsKey,
    mergedIndexLocalSnapshotUsable,
    mergedIndexInsertStatement,
    writeMergedIndexSourceRow,
    bindMergedIndexRow,
    mergedIndexSourcesMatchRoots,
    ensureMergedIndexPendingSnapshotForRoots,
    relativePathsFromFontIndexPayload,
  };
}
