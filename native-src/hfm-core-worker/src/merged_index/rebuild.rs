use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::json;

use super::category::infer_font_search_category;
use super::shared_metadata::SharedMetadataOverlay;
use super::search_text::build_search_text;
use super::tag_revision::merged_index_mutation_protocol;
use super::types::{MergedIndexRebuildConfig, MergedIndexRebuildResult};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergedIndexRebuildPayload {
    merged_index_db_path: String,
    schema_version: i64,
    sources_key: String,
    synced_at: String,
    #[serde(default)]
    sources: Vec<MergedIndexRebuildSource>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MergedIndexRebuildSource {
    pub root: String,
    pub index_db_path: String,
    #[serde(default)]
    pub install_db_path: Option<String>,
    pub index_signature: String,
    pub install_signature: String,
    #[serde(default)]
    pub shared_metadata_signature: Option<String>,
}

#[derive(Clone, Debug)]
pub(super) struct MergedIndexWriteRow {
    pub root_path: String,
    pub relative_path: String,
    pub cache_key: String,
    pub file_size: i64,
    pub modified_at: f64,
    pub created_at: Option<f64>,
    pub status: String,
    pub font_json: Option<String>,
    pub message: Option<String>,
    pub cached_at: String,
    pub installed: Option<i64>,
    pub installed_by: Option<String>,
    pub matches_json: Option<String>,
    pub category_index: String,
    pub search_text: String,
}

pub(super) fn elapsed_since(started_at: Instant) -> u128 {
    started_at.elapsed().as_millis()
}

fn sqlite_literal(value: &str) -> String {
    format!("'{}'", value.replace("'", "''"))
}

fn table_exists(conn: &Connection, table_name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        params![table_name],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}

fn table_columns(conn: &Connection, table_name: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({})", table_name)) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

fn ensure_column(conn: &Connection, table_name: &str, name: &str, definition: &str) -> rusqlite::Result<()> {
    if table_columns(conn, table_name).iter().any(|column| column == name) {
        return Ok(());
    }
    conn.execute(&format!("ALTER TABLE {} ADD COLUMN {} {}", table_name, name, definition), [])?;
    Ok(())
}

pub(super) fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

pub(super) fn initialize_merged_index_db(conn: &Connection, schema_version: i64) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
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
         CREATE INDEX IF NOT EXISTS idx_merged_entries_status ON entries(status, is_deleted);
         CREATE INDEX IF NOT EXISTS idx_merged_entries_modified ON entries(modified_at);
         CREATE INDEX IF NOT EXISTS idx_merged_entries_size ON entries(file_size);
         CREATE INDEX IF NOT EXISTS idx_merged_entries_root ON entries(root_path);
         CREATE INDEX IF NOT EXISTS idx_merged_entries_installed ON entries(installed);
         CREATE INDEX IF NOT EXISTS idx_merged_entries_installed_by ON entries(installed_by);",
    )?;
    ensure_column(conn, "entries", "category_index", "TEXT")?;
    ensure_column(conn, "entries", "search_text", "TEXT NOT NULL DEFAULT ''")?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_merged_entries_category ON entries(category_index)", [])?;
    conn.execute("CREATE INDEX IF NOT EXISTS idx_merged_entries_search_text ON entries(search_text)", [])?;
    set_meta(conn, "schemaVersion", &schema_version.to_string())?;
    set_meta(conn, "cacheArchitecture", "local-derived-merged-index")?;
    Ok(())
}

fn attach_install_status_if_available(conn: &Connection, source: &MergedIndexRebuildSource) -> bool {
    let Some(path) = source.install_db_path.as_deref().filter(|path| !path.is_empty()) else {
        return false;
    };
    if !Path::new(path).exists() {
        return false;
    }
    if conn
        .execute_batch(&format!("ATTACH DATABASE {} AS install_db", sqlite_literal(path)))
        .is_err()
    {
        return false;
    }
    let has_table = conn
        .query_row(
            "SELECT 1 FROM install_db.sqlite_master WHERE type = 'table' AND name = 'install_status' LIMIT 1",
            [],
            |_| Ok(()),
        )
        .optional()
        .ok()
        .flatten()
        .is_some();
    if !has_table {
        let _ = conn.execute_batch("DETACH DATABASE install_db");
    }
    has_table
}

pub(super) fn read_rows_for_source(
    source: &MergedIndexRebuildSource,
    relative_paths: Option<&[String]>,
) -> Result<Vec<MergedIndexWriteRow>, String> {
    let conn = Connection::open_with_flags(
        &source.index_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| error.to_string())?;
    if !table_exists(&conn, "entries") {
        return Ok(Vec::new());
    }
    let has_install_join = attach_install_status_if_available(&conn, source);
    let install_columns = if has_install_join {
        ", install_status.installed AS installed, install_status.by_type AS installed_by, install_status.matches_json AS matches_json"
    } else {
        ", NULL AS installed, NULL AS installed_by, NULL AS matches_json"
    };
    let join_sql = if has_install_join {
        "LEFT JOIN install_db.install_status AS install_status ON install_status.font_id = json_extract(entries.font_json, '$.id')"
    } else {
        ""
    };
    let base_sql = format!(
        "SELECT ? AS root_path, entries.relative_path, entries.cache_key, entries.file_size, entries.modified_at, entries.created_at,
                entries.status, entries.font_json, entries.message, entries.cached_at, COALESCE(entries.is_deleted, 0) AS is_deleted, NULL AS category_index, NULL AS search_text{}
         FROM entries
         {}
         WHERE COALESCE(entries.is_deleted, 0) = 0 AND entries.status = 'ok' AND entries.font_json IS NOT NULL AND json_valid(entries.font_json)",
        install_columns, join_sql
    );
    let overlay = SharedMetadataOverlay::load_for_root(&source.root);
    let mut rows = Vec::new();

    match relative_paths {
        Some(paths) if !paths.is_empty() => {
            for chunk in paths.chunks(500) {
                let placeholders = std::iter::repeat("?").take(chunk.len()).collect::<Vec<_>>().join(",");
                let sql = format!("{} AND entries.relative_path IN ({})", base_sql, placeholders);
                let mut values: Vec<&dyn rusqlite::ToSql> = Vec::with_capacity(chunk.len() + 1);
                values.push(&source.root);
                for path in chunk {
                    values.push(path);
                }
                let mut stmt = conn.prepare(&sql).map_err(|error| error.to_string())?;
                let mapped = stmt
                    .query_map(values.as_slice(), |row| row_to_write_row(row, source, &overlay))
                    .map_err(|error| error.to_string())?;
                rows.extend(mapped.filter_map(Result::ok));
            }
        }
        _ => {
            let mut stmt = conn.prepare(&base_sql).map_err(|error| error.to_string())?;
            let mapped = stmt
                .query_map(params![&source.root], |row| row_to_write_row(row, source, &overlay))
                .map_err(|error| error.to_string())?;
            rows.extend(mapped.filter_map(Result::ok));
        }
    }
    Ok(rows)
}

fn infer_category_index(font_json: Option<&str>) -> String {
    let Some(raw) = font_json else {
        return "sansSerif".to_string();
    };
    match serde_json::from_str::<serde_json::Value>(raw) {
        Ok(value) => infer_font_search_category(&value).to_string(),
        Err(_) => "sansSerif".to_string(),
    }
}

fn row_to_write_row(
    row: &rusqlite::Row<'_>,
    source: &MergedIndexRebuildSource,
    overlay: &SharedMetadataOverlay,
) -> rusqlite::Result<MergedIndexWriteRow> {
    let relative_path = row.get::<_, String>("relative_path")?;
    let font_json = row.get::<_, Option<String>>("font_json")?;
    let applied_font_json = font_json.map(|value| overlay.apply_to_font_json(&source.root, &relative_path, &value));
    let category_index = infer_category_index(applied_font_json.as_deref());
    let search_text = build_search_text(applied_font_json.as_deref(), &source.root, &relative_path, Some(&category_index));
    Ok(MergedIndexWriteRow {
        root_path: row.get("root_path")?,
        relative_path,
        cache_key: row.get("cache_key")?,
        file_size: row.get("file_size")?,
        modified_at: row.get("modified_at")?,
        created_at: row.get("created_at")?,
        status: row.get("status")?,
        font_json: applied_font_json,
        message: row.get("message")?,
        cached_at: row.get::<_, Option<String>>("cached_at")?.unwrap_or_default(),
        installed: row.get("installed")?,
        installed_by: row.get("installed_by")?,
        matches_json: row.get("matches_json")?,
        category_index,
        search_text,
    })
}

fn write_rebuild(
    conn: &Connection,
    payload: &MergedIndexRebuildPayload,
    rows_by_source: &[(MergedIndexRebuildSource, Vec<MergedIndexWriteRow>)],
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|error| error.to_string())?;
    let result = (|| -> rusqlite::Result<()> {
        conn.execute("DELETE FROM entries", [])?;
        conn.execute("DELETE FROM sources", [])?;
        {
            let mut insert_source = conn.prepare(
                "INSERT INTO sources (root_path, index_db_path, install_db_path, index_signature, install_signature, shared_metadata_signature, synced_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )?;
            for source in &payload.sources {
                insert_source.execute(params![
                    &source.root,
                    &source.index_db_path,
                    source.install_db_path.as_deref(),
                    &source.index_signature,
                    &source.install_signature,
                    source.shared_metadata_signature.as_deref().unwrap_or("metadata:none"),
                    &payload.synced_at,
                ])?;
            }
        }
        {
            let mut insert_entry = conn.prepare(
                "INSERT OR REPLACE INTO entries (
                   root_path, relative_path, cache_key, file_size, modified_at, created_at, status, font_json, message, cached_at,
                   is_deleted, installed, installed_by, matches_json, category_index, search_text
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
            )?;
            for (source, rows) in rows_by_source {
                for row in rows {
                    insert_entry.execute(params![
                        if row.root_path.is_empty() { &source.root } else { &row.root_path },
                        &row.relative_path,
                        &row.cache_key,
                        row.file_size,
                        row.modified_at,
                        row.created_at,
                        &row.status,
                        row.font_json.as_deref(),
                        row.message.as_deref(),
                        if row.cached_at.is_empty() { &payload.synced_at } else { &row.cached_at },
                        row.installed,
                        row.installed_by.as_deref(),
                        row.matches_json.as_deref(),
                        &row.category_index,
                        &row.search_text,
                    ])?;
                }
            }
        }
        set_meta(conn, "sourcesKey", &payload.sources_key)?;
        set_meta(conn, "updatedAt", &payload.synced_at)?;
        Ok(())
    })();
    match result {
        Ok(_) => conn.execute_batch("COMMIT").map_err(|error| error.to_string()),
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error.to_string())
        }
    }
}

fn json_output(payload: &MergedIndexRebuildPayload, rows: i64, timings: BTreeMap<&str, u128>, started_at: &Instant) -> Result<String, String> {
    let result = json!({
        "ok": true,
        "rebuilt": true,
        "rows": rows,
        "elapsedMs": started_at.elapsed().as_millis(),
        "workerMode": "rust-merged-index-rebuild",
        "indexProtocol": merged_index_mutation_protocol(
            "--merged-index-rebuild",
            "merged-index-rebuild",
            &payload.sources_key,
            &payload.synced_at,
            rows,
            rows,
            true,
            Some("rust-rebuild"),
        ),
        "timings": timings,
    });
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn rebuild_merged_index(config: &MergedIndexRebuildConfig) -> Result<MergedIndexRebuildResult, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: MergedIndexRebuildPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if payload.merged_index_db_path.trim().is_empty() {
        return Err("missing mergedIndexDbPath".to_string());
    }
    let mut timings: BTreeMap<&str, u128> = BTreeMap::new();

    let open_started_at = Instant::now();
    let conn = Connection::open(&payload.merged_index_db_path).map_err(|error| error.to_string())?;
    initialize_merged_index_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    timings.insert("open", elapsed_since(open_started_at));

    let read_started_at = Instant::now();
    let mut rows_by_source = Vec::new();
    let mut total_rows = 0_i64;
    for source in &payload.sources {
        let rows = read_rows_for_source(source, None)?;
        total_rows += rows.len() as i64;
        rows_by_source.push((source.clone(), rows));
    }
    timings.insert("readSources", elapsed_since(read_started_at));

    let write_started_at = Instant::now();
    write_rebuild(&conn, &payload, &rows_by_source)?;
    timings.insert("write", elapsed_since(write_started_at));

    Ok(MergedIndexRebuildResult {
        json: json_output(&payload, total_rows, timings, &started_at)?,
    })
}
