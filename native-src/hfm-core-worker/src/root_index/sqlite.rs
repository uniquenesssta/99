use std::fs;
use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use sha1::{Digest, Sha1};

use super::types::{RootIndexApplyConfig, RootIndexApplyPayload, RootIndexApplyResult, RootIndexEntry};

fn ensure_parent_dir(path: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn initialize_root_index_db(conn: &Connection, config: &RootIndexApplyConfig) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS entries (
          relative_path TEXT PRIMARY KEY,
          cache_key TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          modified_at REAL NOT NULL,
          created_at REAL,
          status TEXT NOT NULL,
          font_json TEXT,
          message TEXT,
          cached_at TEXT NOT NULL,
          is_deleted INTEGER NOT NULL DEFAULT 0,
          deleted_at TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          opstamp INTEGER NOT NULL DEFAULT 0,
          file_identity TEXT,
          content_hash TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);
        CREATE INDEX IF NOT EXISTS idx_entries_modified ON entries(modified_at);
        CREATE TABLE IF NOT EXISTS index_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          opstamp INTEGER NOT NULL,
          event_type TEXT NOT NULL,
          relative_path TEXT NOT NULL,
          previous_relative_path TEXT,
          font_id TEXT,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_index_events_opstamp ON index_events(opstamp);
        CREATE INDEX IF NOT EXISTS idx_index_events_path ON index_events(relative_path);
        CREATE TABLE IF NOT EXISTS directories (
          relative_path TEXT PRIMARY KEY,
          modified_at REAL NOT NULL,
          file_count INTEGER NOT NULL,
          dir_count INTEGER NOT NULL,
          scanned_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_directories_modified ON directories(modified_at);
        CREATE INDEX IF NOT EXISTS idx_entries_deleted ON entries(is_deleted);
        CREATE INDEX IF NOT EXISTS idx_entries_identity ON entries(file_identity);
        "#,
    )?;

    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;");
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN deleted_at TEXT;");
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;");
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN opstamp INTEGER NOT NULL DEFAULT 0;");
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN file_identity TEXT;");
    let _ = conn.execute_batch("ALTER TABLE entries ADD COLUMN content_hash TEXT;");

    let now = sqlite_now(conn)?;
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params!["schema_version", config.schema_version.to_string()])?;
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params!["schemaVersion", config.schema_version.to_string()])?;
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params!["index_version", config.cache_version.to_string()])?;
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params!["cacheVersion", config.cache_version.to_string()])?;
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params!["scriptDetectionVersion", config.script_detection_version.to_string()])?;
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params!["rootPath", &config.root_path])?;
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params!["storage", &config.storage])?;
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params!["updatedAt", now])?;
    Ok(())
}

fn sqlite_now(conn: &Connection) -> rusqlite::Result<String> {
    conn.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| row.get(0))
}

fn tx_now(tx: &Transaction<'_>) -> rusqlite::Result<String> {
    tx.query_row("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now')", [], |row| row.get(0))
}

fn meta_number(tx: &Transaction<'_>, key: &str, fallback: i64) -> rusqlite::Result<i64> {
    let value: Option<String> = tx
        .query_row("SELECT value FROM meta WHERE key = ?", params![key], |row| row.get(0))
        .optional()?;
    Ok(value.and_then(|text| text.parse::<i64>().ok()).unwrap_or(fallback))
}

fn set_meta(tx: &Transaction<'_>, key: &str, value: &str) -> rusqlite::Result<()> {
    tx.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params![key, value])?;
    Ok(())
}

fn next_opstamp(tx: &Transaction<'_>) -> rusqlite::Result<i64> {
    let next = meta_number(tx, "index_opstamp", 0)? + 1;
    set_meta(tx, "index_opstamp", &next.to_string())?;
    Ok(next)
}

fn font_id(entry: &RootIndexEntry) -> String {
    entry
        .font
        .as_ref()
        .and_then(|font| font.get("id"))
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string()
}

fn font_json(entry: &RootIndexEntry) -> Option<String> {
    entry.font.as_ref().and_then(|value| serde_json::to_string(value).ok())
}

fn file_identity(relative_path: &str, entry: &RootIndexEntry) -> String {
    let content_hash = entry.content_hash.clone().unwrap_or_default();
    let input = format!(
        "{}|{}|{}|{}|{}|{}",
        relative_path,
        entry.cache_key,
        entry.file_size.round() as i64,
        entry.modified_at.round() as i64,
        content_hash,
        font_id(entry),
    );
    format!("{:x}", Sha1::digest(input.as_bytes()))
}

fn insert_index_event(tx: &Transaction<'_>, event_type: &str, relative_path: &str, font_id: Option<String>, payload_json: String, now: &str) -> rusqlite::Result<()> {
    let opstamp = next_opstamp(tx)?;
    tx.execute(
        r#"
        INSERT INTO index_events (opstamp, event_type, relative_path, previous_relative_path, font_id, payload_json, created_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?)
        "#,
        params![opstamp, event_type, relative_path, font_id, payload_json, now],
    )?;
    Ok(())
}

fn apply_delete(tx: &Transaction<'_>, relative_path: &str, deleted_at: &str) -> rusqlite::Result<()> {
    let opstamp = next_opstamp(tx)?;
    tx.execute(
        r#"
        UPDATE entries
        SET is_deleted = 1, status = 'deleted', deleted_at = ?, opstamp = ?, revision = COALESCE(revision, 0) + 1
        WHERE relative_path = ?
        "#,
        params![deleted_at, opstamp, relative_path],
    )?;
    let payload = serde_json::json!({ "relativePath": relative_path }).to_string();
    insert_index_event(tx, "delete", relative_path, None, payload, deleted_at)
}

fn apply_upsert(tx: &Transaction<'_>, relative_path: &str, entry: &RootIndexEntry, now: &str) -> rusqlite::Result<()> {
    let status = if entry.status == "bad" { "bad" } else { "ok" };
    let cached_at = entry.cached_at.as_deref().unwrap_or(now);
    let message = entry.message.as_deref();
    let content_hash = entry.content_hash.as_deref();
    let font_json = font_json(entry);
    let identity = file_identity(relative_path, entry);
    let opstamp = next_opstamp(tx)?;
    tx.execute(
        r#"
        INSERT INTO entries (
          relative_path, cache_key, file_size, modified_at, created_at, status, font_json, message, cached_at,
          is_deleted, deleted_at, revision, opstamp, file_identity, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?, ?, ?)
        ON CONFLICT(relative_path) DO UPDATE SET
          cache_key = excluded.cache_key,
          file_size = excluded.file_size,
          modified_at = excluded.modified_at,
          created_at = excluded.created_at,
          status = excluded.status,
          font_json = excluded.font_json,
          message = excluded.message,
          cached_at = excluded.cached_at,
          is_deleted = 0,
          deleted_at = NULL,
          revision = COALESCE(entries.revision, 0) + 1,
          opstamp = excluded.opstamp,
          file_identity = excluded.file_identity,
          content_hash = excluded.content_hash
        "#,
        params![
            relative_path,
            entry.cache_key,
            entry.file_size.round() as i64,
            entry.modified_at,
            entry.created_at,
            status,
            font_json,
            message,
            cached_at,
            opstamp,
            identity,
            content_hash,
        ],
    )?;
    let font_id = font_id(entry);
    let payload = serde_json::json!({
        "relativePath": relative_path,
        "status": status,
        "fontId": if font_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(font_id.clone()) },
    }).to_string();
    insert_index_event(tx, "upsert", relative_path, if font_id.is_empty() { None } else { Some(font_id) }, payload, now)
}

pub fn apply_root_index_changes(config: &RootIndexApplyConfig) -> Result<RootIndexApplyResult, String> {
    ensure_parent_dir(&config.db_path)?;
    let payload_text = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: RootIndexApplyPayload = serde_json::from_str(&payload_text).map_err(|error| error.to_string())?;
    let mut conn = Connection::open(&config.db_path).map_err(|error| error.to_string())?;
    initialize_root_index_db(&conn, config).map_err(|error| error.to_string())?;

    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    let now = tx_now(&tx).map_err(|error| error.to_string())?;
    let result = (|| -> rusqlite::Result<RootIndexApplyResult> {
        for relative_path in &payload.deletes {
            apply_delete(&tx, relative_path, &now)?;
        }
        for upsert in &payload.upserts {
            apply_upsert(&tx, &upsert.relative_path, &upsert.entry, &now)?;
        }
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM entries WHERE COALESCE(is_deleted, 0) = 0 AND status <> 'deleted'",
            [],
            |row| row.get(0),
        )?;
        set_meta(&tx, "updatedAt", &now)?;
        set_meta(&tx, "last_update.entry_state_check", &now)?;
        set_meta(&tx, "fileCount", &count.to_string())?;
        Ok(RootIndexApplyResult {
            count,
            upserts: payload.upserts.len(),
            deletes: payload.deletes.len(),
        })
    })();

    match result {
        Ok(summary) => {
            tx.commit().map_err(|error| error.to_string())?;
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            Ok(summary)
        }
        Err(error) => Err(error.to_string()),
    }
}
