use std::collections::BTreeMap;
use std::fs;
use std::time::Instant;

use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::json;

use super::rebuild::{
    elapsed_since, initialize_merged_index_db, read_rows_for_source, set_meta,
    MergedIndexRebuildSource, MergedIndexWriteRow,
};
use super::tag_revision::merged_index_mutation_protocol;
use super::types::{MergedIndexSyncConfig, MergedIndexSyncResult};

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MergedIndexSyncPayload {
    merged_index_db_path: String,
    schema_version: i64,
    sources_key: String,
    synced_at: String,
    source: MergedIndexRebuildSource,
    #[serde(default)]
    relative_paths: Vec<String>,
    #[serde(default)]
    full_snapshot: bool,
    #[serde(default)]
    reason: Option<String>,
}

fn insert_source_row(
    conn: &Connection,
    source: &MergedIndexRebuildSource,
    synced_at: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO sources (root_path, index_db_path, install_db_path, index_signature, install_signature, shared_metadata_signature, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        params![
            &source.root,
            &source.index_db_path,
            source.install_db_path.as_deref(),
            &source.index_signature,
            &source.install_signature,
            source.shared_metadata_signature.as_deref().unwrap_or("metadata:none"),
            synced_at,
        ],
    )?;
    Ok(())
}

fn insert_entry_row(
    stmt: &mut rusqlite::Statement<'_>,
    source: &MergedIndexRebuildSource,
    row: &MergedIndexWriteRow,
    synced_at: &str,
) -> rusqlite::Result<()> {
    stmt.execute(params![
        if row.root_path.is_empty() { source.root.as_str() } else { row.root_path.as_str() },
        &row.relative_path,
        &row.cache_key,
        row.file_size,
        row.modified_at,
        row.created_at,
        &row.status,
        row.font_json.as_deref(),
        row.message.as_deref(),
        if row.cached_at.is_empty() { synced_at } else { row.cached_at.as_str() },
        row.installed,
        row.installed_by.as_deref(),
        row.matches_json.as_deref(),
        &row.category_index,
        &row.search_text,
    ])?;
    Ok(())
}

fn write_sync(
    conn: &Connection,
    payload: &MergedIndexSyncPayload,
    rows: &[MergedIndexWriteRow],
) -> Result<(), String> {
    conn.execute_batch("BEGIN IMMEDIATE").map_err(|error| error.to_string())?;
    let result = (|| -> rusqlite::Result<()> {
        if payload.full_snapshot {
            conn.execute("DELETE FROM entries WHERE root_path = ?", params![&payload.source.root])?;
        } else {
            let mut delete_entry = conn.prepare("DELETE FROM entries WHERE root_path = ? AND relative_path = ?")?;
            for relative_path in &payload.relative_paths {
                delete_entry.execute(params![&payload.source.root, relative_path])?;
            }
        }

        {
            let mut insert_entry = conn.prepare(
                "INSERT OR REPLACE INTO entries (
                   root_path, relative_path, cache_key, file_size, modified_at, created_at, status, font_json, message, cached_at,
                   is_deleted, installed, installed_by, matches_json, category_index, search_text
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)",
            )?;
            for row in rows {
                insert_entry_row(&mut insert_entry, &payload.source, row, &payload.synced_at)?;
            }
        }

        insert_source_row(conn, &payload.source, &payload.synced_at)?;
        set_meta(conn, "sourcesKey", &payload.sources_key)?;
        set_meta(conn, "updatedAt", &payload.synced_at)?;
        let reason_key = if payload.full_snapshot {
            "lastRootSnapshotSyncReason"
        } else {
            "lastIncrementalSyncReason"
        };
        set_meta(conn, reason_key, payload.reason.as_deref().unwrap_or("rust-sync"))?;
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

fn json_output(
    changed: usize,
    rows: usize,
    full_snapshot: bool,
    timings: BTreeMap<&str, u128>,
    payload: &MergedIndexSyncPayload,
    started_at: &Instant,
) -> Result<String, String> {
    let result = json!({
        "ok": true,
        "synced": true,
        "changed": changed,
        "rows": rows,
        "fullSnapshot": full_snapshot,
        "elapsedMs": started_at.elapsed().as_millis(),
        "workerMode": "rust-merged-index-sync",
        "indexProtocol": merged_index_mutation_protocol(
            "--merged-index-sync",
            if full_snapshot { "merged-index-root-snapshot-sync" } else { "merged-index-incremental-sync" },
            &payload.sources_key,
            &payload.synced_at,
            rows as i64,
            changed as i64,
            full_snapshot,
            payload.reason.as_deref(),
        ),
        "timings": timings,
    });
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn normalize_relative_paths(paths: &[String]) -> Vec<String> {
    let mut normalized = Vec::with_capacity(paths.len());
    for path in paths {
        let value = path.replace('\\', "/");
        if !value.is_empty() && !normalized.contains(&value) {
            normalized.push(value);
        }
    }
    normalized
}

pub fn sync_merged_index(config: &MergedIndexSyncConfig) -> Result<MergedIndexSyncResult, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let mut payload: MergedIndexSyncPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if payload.merged_index_db_path.trim().is_empty() {
        return Err("missing mergedIndexDbPath".to_string());
    }
    payload.relative_paths = normalize_relative_paths(&payload.relative_paths);
    if !payload.full_snapshot && payload.relative_paths.is_empty() {
        return Err("missing relativePaths for incremental sync".to_string());
    }

    let mut timings: BTreeMap<&str, u128> = BTreeMap::new();

    let open_started_at = Instant::now();
    let conn = Connection::open(&payload.merged_index_db_path).map_err(|error| error.to_string())?;
    initialize_merged_index_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    timings.insert("open", elapsed_since(open_started_at));

    let read_started_at = Instant::now();
    let rows = if payload.full_snapshot {
        read_rows_for_source(&payload.source, None)?
    } else {
        read_rows_for_source(&payload.source, Some(&payload.relative_paths))?
    };
    timings.insert("readSource", elapsed_since(read_started_at));

    let write_started_at = Instant::now();
    write_sync(&conn, &payload, &rows)?;
    timings.insert("write", elapsed_since(write_started_at));

    Ok(MergedIndexSyncResult {
        json: json_output(
            payload.relative_paths.len(),
            rows.len(),
            payload.full_snapshot,
            timings,
            &payload,
            &started_at,
        )?,
    })
}
