use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::Connection;
use serde::Deserialize;

use super::types::{SharedMetadataCommandConfig, SharedMetadataSignatureResult, SharedMetadataTimings};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedMetadataSignaturePayload {
    db_path: String,
}

pub fn read_shared_metadata_signature(config: &SharedMetadataCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: SharedMetadataSignaturePayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let signature = shared_metadata_signature(&payload.db_path)?;
    let result = SharedMetadataSignatureResult {
        ok: true,
        signature,
        timings: SharedMetadataTimings {
            elapsed: started_at.elapsed().as_millis(),
            rows: 1,
        },
        worker_mode: "rust-shared-metadata-signature".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn shared_metadata_signature(db_path: &str) -> Result<String, String> {
    if db_path.trim().is_empty() || !Path::new(db_path).exists() {
        return Ok("metadata:none".to_string());
    }

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    if !table_exists(&conn, "font_metadata").map_err(|error| error.to_string())? {
        return Ok("metadata:none".to_string());
    }

    shared_metadata_signature_for_conn(&conn).map_err(|error| error.to_string())
}

pub fn shared_metadata_signature_for_conn(conn: &Connection) -> rusqlite::Result<String> {
    let updated_at = read_meta(conn, "updatedAt").unwrap_or_default();
    let row = conn.query_row(
        "SELECT COUNT(*) AS count,
                COALESCE(MAX(revision), 0) AS max_revision,
                COALESCE(MAX(updated_at), '') AS max_updated_at
         FROM font_metadata",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    )?;
    let tag_ops = if table_exists(conn, "shared_tag_ops")? {
        conn.query_row(
            "SELECT COUNT(*) AS op_count, COALESCE(MAX(rowid), 0) AS max_op_rowid FROM shared_tag_ops",
            [],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
        )?
    } else {
        (0, 0)
    };

    Ok(format!(
        "metadata-v2|{}|{}|{}|{}|{}|{}",
        updated_at,
        row.0,
        row.1,
        row.2,
        tag_ops.0,
        tag_ops.1
    ))
}

fn table_exists(conn: &Connection, table_name: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        [table_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn read_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key=?", [key], |row| row.get(0)).ok()
}
