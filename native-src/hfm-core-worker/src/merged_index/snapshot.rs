use std::collections::BTreeSet;

use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OptionalExtension};

use super::path_utils::{normalize_path_for_compare, shared_font_id};

pub fn table_columns(conn: &Connection, table_name: &str) -> BTreeSet<String> {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA table_info({})", table_name)) else {
        return BTreeSet::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return BTreeSet::new();
    };
    rows.filter_map(Result::ok).collect()
}

pub fn local_table_columns(conn: &Connection, table_name: &str) -> BTreeSet<String> {
    let Ok(mut stmt) = conn.prepare(&format!("PRAGMA local_db.table_info({})", table_name)) else {
        return BTreeSet::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(1)) else {
        return BTreeSet::new();
    };
    rows.filter_map(Result::ok).collect()
}

fn table_has_columns(conn: &Connection, table_name: &str, columns: &[&str]) -> bool {
    let existing = table_columns(conn, table_name);
    columns.iter().all(|column| existing.contains(*column))
}

fn merged_index_required_schema_usable(conn: &Connection) -> bool {
    table_has_columns(
        conn,
        "sources",
        &[
            "root_path",
            "index_db_path",
            "install_db_path",
            "index_signature",
            "install_signature",
            "synced_at",
        ],
    ) && table_has_columns(
        conn,
        "entries",
        &[
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
        ],
    )
}

pub fn roots_snapshot_usable(conn: &Connection, roots: &[String], schema_version: i64) -> rusqlite::Result<bool> {
    let schema: Option<String> = conn
        .query_row("SELECT value FROM meta WHERE key = 'schemaVersion' LIMIT 1", [], |row| row.get(0))
        .optional()?;
    if schema.unwrap_or_default() != schema_version.to_string() {
        return Ok(false);
    }
    if !merged_index_required_schema_usable(conn) {
        return Ok(false);
    }

    let mut stmt = conn.prepare("SELECT root_path FROM sources ORDER BY root_path")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let actual: BTreeSet<String> = rows
        .filter_map(Result::ok)
        .map(|value| normalize_path_for_compare(&value))
        .filter(|value| !value.is_empty())
        .collect();
    let expected: BTreeSet<String> = roots
        .iter()
        .map(|value| normalize_path_for_compare(value))
        .filter(|value| !value.is_empty())
        .collect();
    if actual != expected {
        return Ok(false);
    }

    Ok(true)
}

pub fn register_shared_font_id(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function(
        "hfm_shared_font_id",
        3,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC,
        |ctx| {
            let cache_identity: String = ctx.get::<String>(0).unwrap_or_default();
            let size = ctx.get::<f64>(1).unwrap_or(0.0);
            let mtime_ms = ctx.get::<f64>(2).unwrap_or(0.0);
            Ok(shared_font_id(&cache_identity, size, mtime_ms))
        },
    )
}
