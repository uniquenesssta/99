use std::collections::BTreeMap;
use std::path::Path;

use rusqlite::Connection;
use serde_json::{json, Value};

pub fn merged_index_tag_revision_metadata(
    conn: &Connection,
    library_db_path: &str,
    requested: &Value,
) -> Value {
    let local_signature = local_tags_signature(library_db_path);
    json!({
        "source": "rust-merged-index",
        "requested": requested.clone(),
        "mergedIndex": read_merged_index_meta(conn),
        "localTagsSignature": local_signature,
        "sharedMetadataSignatures": read_source_shared_signatures(conn),
    })
}

pub fn merged_index_mutation_protocol(
    command: &str,
    mutation_kind: &str,
    sources_key: &str,
    synced_at: &str,
    rows: i64,
    changed: i64,
    full_snapshot: bool,
    reason: Option<&str>,
) -> Value {
    json!({
        "ok": true,
        "command": command,
        "domain": "mergedIndex",
        "mutationKind": mutation_kind,
        "source": "rust-worker",
        "changedIds": [],
        "updatedAt": synced_at,
        "sourcesKey": sources_key,
        "rows": rows,
        "changed": changed,
        "fullSnapshot": full_snapshot,
        "reason": reason.unwrap_or("rust-merged-index"),
        "cacheInvalidated": true,
        "mergedIndexDirty": true,
        "pageQueryDirty": true,
        "metricsDirty": true,
        "workerMode": if command == "--merged-index-rebuild" { "rust-merged-index-rebuild" } else { "rust-merged-index-sync" },
    })
}

fn read_merged_index_meta(conn: &Connection) -> Value {
    json!({
        "schemaVersion": read_meta(conn, "schemaVersion"),
        "sourcesKey": read_meta(conn, "sourcesKey"),
        "updatedAt": read_meta(conn, "updatedAt"),
        "lastIncrementalSyncReason": read_meta(conn, "lastIncrementalSyncReason"),
        "lastRootSnapshotSyncReason": read_meta(conn, "lastRootSnapshotSyncReason"),
    })
}

fn read_source_shared_signatures(conn: &Connection) -> BTreeMap<String, String> {
    let mut result = BTreeMap::<String, String>::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT root_path, COALESCE(shared_metadata_signature, 'metadata:none') FROM sources ORDER BY root_path"
    ) else {
        return result;
    };
    let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) else {
        return result;
    };
    for row in rows.filter_map(Result::ok) {
        result.insert(row.0, row.1);
    }
    result
}

fn local_tags_signature(library_db_path: &str) -> String {
    let path = library_db_path.trim();
    if path.is_empty() || !Path::new(path).exists() {
        return "local-tags:none".to_string();
    }
    let Ok(conn) = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return "local-tags:error".to_string();
    };
    if !table_exists(&conn, "local_font_tags") {
        return "local-tags:none".to_string();
    }
    let updated_at = read_meta(&conn, "updatedAt");
    match conn.query_row(
        "SELECT COUNT(*) AS count,
                COALESCE(MAX(updated_at), '') AS max_updated_at,
                COALESCE(COUNT(DISTINCT tag_name), 0) AS tag_count
         FROM local_font_tags",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    ) {
        Ok((count, max_updated_at, tag_count)) => format!(
            "local-tags-v1|{}|{}|{}|{}",
            updated_at,
            count,
            max_updated_at,
            tag_count
        ),
        Err(_) => "local-tags:error".to_string(),
    }
}

fn table_exists(conn: &Connection, table_name: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        [table_name],
        |row| row.get::<_, i64>(0),
    )
    .map(|count| count > 0)
    .unwrap_or(false)
}

fn read_meta(conn: &Connection, key: &str) -> String {
    conn.query_row("SELECT value FROM meta WHERE key=?", [key], |row| row.get::<_, String>(0))
        .unwrap_or_default()
}
