use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};
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
    prepared_rows: Option<Vec<MergedIndexWriteRow>>,
    #[serde(default)]
    preserve_source_checkpoint: bool,
    #[serde(default)]
    expected_sources_key: Option<String>,
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
        if let Some(expected) = &payload.expected_sources_key {
            let current: Option<String> = conn.query_row("SELECT value FROM meta WHERE key='sourcesKey'", [], |row| row.get(0)).optional()?;
            if current.unwrap_or_default() != *expected { return Err(rusqlite::Error::InvalidQuery); }
        }
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

        if payload.preserve_source_checkpoint {
            let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM sources WHERE root_path=?)", params![&payload.source.root], |row| row.get(0))?;
            if !exists { return Err(rusqlite::Error::InvalidQuery); }
        } else {
            insert_source_row(conn, &payload.source, &payload.synced_at)?;
        }
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

fn validate_prepared_rows(payload: &MergedIndexSyncPayload, rows: &[MergedIndexWriteRow]) -> Result<(), String> {
    if payload.expected_sources_key.is_none() { return Err("prepared sync requires an applied checkpoint".to_string()); }
    if !payload.full_snapshot && !payload.preserve_source_checkpoint {
        return Err("partial prepared sync must preserve source checkpoint".to_string());
    }
    if payload.preserve_source_checkpoint && (payload.full_snapshot || payload.expected_sources_key.as_deref() != Some(payload.sources_key.as_str())) {
        return Err("partial prepared sync cannot advance source checkpoint".to_string());
    }
    let mut paths = BTreeSet::new();
    for row in rows {
        let path = row.relative_path.replace('\\', "/");
        if row.root_path != payload.source.root || path.is_empty() || path.starts_with('/')
            || path.contains(':') || path.contains('\0') || path.split('/').any(|part| part == "..")
            || !paths.insert(path.clone()) || (!payload.full_snapshot && !payload.relative_paths.contains(&path)) {
            return Err("prepared sync row outside target".to_string());
        }
    }
    Ok(())
}

pub fn sync_merged_index(config: &MergedIndexSyncConfig) -> Result<MergedIndexSyncResult, String> {
    let started_at = Instant::now();
    if fs::metadata(&config.input_path).map_err(|error| error.to_string())?.len() > 40 * 1024 * 1024 {
        return Err("merged sync input exceeds bounded payload".to_string());
    }
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let mut payload: MergedIndexSyncPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if payload.merged_index_db_path.trim().is_empty() {
        return Err("missing mergedIndexDbPath".to_string());
    }
    if payload.preserve_source_checkpoint && payload.prepared_rows.is_none() {
        return Err("checkpoint preservation requires prepared rows".to_string());
    }
    payload.relative_paths = normalize_relative_paths(&payload.relative_paths);
    if !payload.full_snapshot && payload.relative_paths.is_empty() {
        return Err("missing relativePaths for incremental sync".to_string());
    }

    let mut timings: BTreeMap<&str, u128> = BTreeMap::new();

    let open_started_at = Instant::now();
    let conn = Connection::open(&payload.merged_index_db_path).map_err(|error| error.to_string())?;
    if payload.prepared_rows.is_some() {
        let schema: String = conn.query_row("SELECT value FROM meta WHERE key='schemaVersion'", [], |row| row.get(0)).map_err(|error| error.to_string())?;
        if schema != payload.schema_version.to_string() { return Err("prepared sync schema mismatch".to_string()); }
    } else {
        initialize_merged_index_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    }
    timings.insert("open", elapsed_since(open_started_at));

    let read_started_at = Instant::now();
    let rows = if let Some(rows) = payload.prepared_rows.take() {
        validate_prepared_rows(&payload, &rows)?;
        rows
    } else if payload.full_snapshot {
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

#[cfg(test)]
mod prepared_sync_tests {
    use super::*;

    fn payload() -> MergedIndexSyncPayload {
        serde_json::from_value(json!({
            "mergedIndexDbPath": "unused", "schemaVersion": 7, "sourcesKey": "after", "expectedSourcesKey": "before", "syncedAt": "now",
            "source": {"root":"Z:/healthy", "indexDbPath":"//offline/never-read.sqlite", "indexSignature":"root-v3|1", "installSignature":"none", "sharedMetadataSignature":"metadata:none"},
            "fullSnapshot":true, "preparedRows": [{"root_path":"Z:/healthy", "relative_path":"a.ttf", "cache_key":"a.ttf", "file_size":1,
                "modified_at":1, "created_at":null, "status":"ok", "font_json":"{}", "message":null, "cached_at":"now", "installed":null,
                "installed_by":null,"matches_json":null,"category_index":"sansSerif","search_text":"a"}]
        })).unwrap()
    }

    #[test]
    fn merged_prepared_sync_transaction_preserves_peer_and_rejects_changed_checkpoint() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_merged_index_db(&conn, 7).unwrap();
        set_meta(&conn, "sourcesKey", "before").unwrap();
        conn.execute("INSERT INTO sources VALUES('peer','offline',NULL,'old-index','old-install','old-metadata','old-time')", []).unwrap();
        let mut input = payload();
        let rows = input.prepared_rows.take().unwrap();
        validate_prepared_rows(&input, &rows).unwrap();
        write_sync(&conn, &input, &rows).unwrap();
        let peer: (String, String) = conn.query_row("SELECT index_signature,synced_at FROM sources WHERE root_path='peer'", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(peer, ("old-index".to_string(),"old-time".to_string()));
        assert!(write_sync(&conn, &input, &[]).is_err());
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0)).unwrap();
        assert_eq!(count, 1, "rejected stale transaction deleted a committed row");
    }

    #[test]
    fn merged_prepared_sync_rejects_wrong_root_path_and_missing_checkpoint() {
        let mut input = payload();
        let mut rows = input.prepared_rows.take().unwrap();
        rows[0].root_path = "peer".to_string();
        assert!(validate_prepared_rows(&input, &rows).is_err());
        rows[0].root_path = input.source.root.clone();
        rows[0].relative_path = "../outside.ttf".to_string();
        assert!(validate_prepared_rows(&input, &rows).is_err());
        rows[0].relative_path = "a.ttf".to_string();
        input.expected_sources_key = None;
        assert!(validate_prepared_rows(&input, &rows).is_err());
    }

    #[test]
    fn merged_prepared_sync_incremental_cannot_write_unrequested_row() {
        let mut input = payload();
        let rows = input.prepared_rows.take().unwrap();
        input.full_snapshot = false;
        input.preserve_source_checkpoint = true;
        input.sources_key = "before".to_string();
        input.relative_paths = vec!["different.ttf".to_string()];
        assert!(validate_prepared_rows(&input, &rows).is_err());
        input.relative_paths = vec!["a.ttf".to_string()];
        assert!(validate_prepared_rows(&input, &rows).is_ok());
    }
    #[test]
    fn merged_prepared_sync_partial_preserves_certificate_for_restart_reconciliation() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_merged_index_db(&conn, 7).unwrap();
        set_meta(&conn, "sourcesKey", "before").unwrap();
        conn.execute("INSERT INTO sources VALUES('Z:/healthy','old-index',NULL,'old-revision','none','old-metadata','old-time')", []).unwrap();
        let mut input = payload();
        let rows = input.prepared_rows.take().unwrap();
        input.full_snapshot = false;
        input.relative_paths = vec!["a.ttf".to_string()];
        input.preserve_source_checkpoint = true;
        input.sources_key = "before".to_string();
        validate_prepared_rows(&input, &rows).unwrap();
        write_sync(&conn, &input, &rows).unwrap();
        let retained: (String, String) = conn.query_row("SELECT index_signature,synced_at FROM sources WHERE root_path='Z:/healthy'", [], |row| Ok((row.get(0)?,row.get(1)?))).unwrap();
        assert_eq!(retained, ("old-revision".to_string(),"old-time".to_string()));
        let key: String = conn.query_row("SELECT value FROM meta WHERE key='sourcesKey'", [], |row| row.get(0)).unwrap();
        assert_eq!(key, "before");
        input.sources_key = "new-unproved-checkpoint".to_string();
        assert!(validate_prepared_rows(&input, &rows).is_err());
    }

}
