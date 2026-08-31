use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

use crate::mutation_protocol::{json_value, tag_mutation_protocol_result};

use super::schema::{initialize_shared_metadata_db, set_meta};
use super::signature::shared_metadata_signature_for_conn;
use super::types::{
    SharedMetadataApplyPayload, SharedMetadataApplyResult, SharedMetadataCommandConfig,
    SharedMetadataMutationStateSignal, SharedMetadataRemoveTagPayload, SharedMetadataRemoveTagResult,
    SharedMetadataTimings,
};

static TAG_OP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug)]
struct ExistingMetadataState {
    tag_names: Vec<String>,
    favorite: bool,
    delete_protected: bool,
    revision: i64,
}

#[derive(Clone, Debug)]
struct MergedMetadataState {
    tag_names: Vec<String>,
    favorite: bool,
    delete_protected: bool,
    added_tags: Vec<String>,
    removed_tags: Vec<String>,
    base_revision: i64,
}

#[derive(Clone, Debug)]
struct TagTarget {
    font_id: String,
    relative_path: String,
    path_key: String,
    next_tags: Vec<String>,
    previous_tags: Vec<String>,
    revision: i64,
}

pub fn apply_shared_metadata_state_machine(config: &SharedMetadataCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: SharedMetadataApplyPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_shared_metadata_db(&conn).map_err(|error| error.to_string())?;

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut written = 0usize;
    let mut events = 0usize;
    let mut changed_ids: Vec<String> = Vec::new();
    {
        let mut upsert = tx.prepare(
            "INSERT INTO font_metadata (
               font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision, updated_at, updated_by
             ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(font_id) DO UPDATE SET
               relative_path = excluded.relative_path,
               path_key = excluded.path_key,
               tag_names_json = excluded.tag_names_json,
               favorite = excluded.favorite,
               delete_protected = excluded.delete_protected,
               revision = COALESCE(font_metadata.revision, 0) + 1,
               updated_at = excluded.updated_at,
               updated_by = excluded.updated_by"
        ).map_err(|error| error.to_string())?;
        let mut existing_select = tx.prepare(
            "SELECT tag_names_json, favorite, delete_protected, revision FROM font_metadata WHERE font_id = ?"
        ).map_err(|error| error.to_string())?;
        let mut event_insert = tx.prepare(
            "INSERT INTO metadata_events (event_type, font_id, relative_path, payload_json, created_at, writer_host, writer_pid)
             VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).map_err(|error| error.to_string())?;
        let mut tag_op_insert = tx.prepare(
            "INSERT OR IGNORE INTO shared_tag_ops (
               op_id, font_id, relative_path, path_key, action, tag_name, base_revision, next_revision, created_at, machine_id, writer_pid, tombstone
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).map_err(|error| error.to_string())?;

        for row in &payload.rows {
            let font_id = row.font_id.trim();
            if font_id.is_empty() {
                continue;
            }
            let requested_tags = parse_tags(&row.tag_names_json);
            let base_tags = parse_tags(&row.base_tag_names_json);
            let existing = existing_select.query_row(params![font_id], |item| {
                let tag_names_json: String = item.get(0)?;
                let favorite: i64 = item.get(1)?;
                let delete_protected: i64 = item.get(2)?;
                let revision: i64 = item.get(3)?;
                Ok(ExistingMetadataState {
                    tag_names: parse_tags(&tag_names_json),
                    favorite: favorite != 0,
                    delete_protected: delete_protected != 0,
                    revision,
                })
            }).optional().map_err(|error| error.to_string())?;
            let merged = merge_metadata_state(
                &row.merge_policy,
                existing.clone(),
                &base_tags,
                &requested_tags,
                row.favorite,
                row.delete_protected,
            );
            if metadata_state_unchanged(existing.as_ref(), &merged) {
                continue;
            }
            let tag_names_json = serde_json::to_string(&merged.tag_names).unwrap_or_else(|_| "[]".to_string());
            upsert.execute(params![
                font_id,
                &row.relative_path,
                &row.path_key,
                &tag_names_json,
                if merged.favorite { 1 } else { 0 },
                if merged.delete_protected { 1 } else { 0 },
                &payload.updated_at,
                &payload.updated_by,
            ]).map_err(|error| error.to_string())?;
            let next_revision = if merged.base_revision > 0 { merged.base_revision + 1 } else { 1 };
            insert_tag_ops(
                &mut tag_op_insert,
                font_id,
                &row.relative_path,
                &row.path_key,
                &merged.added_tags,
                &merged.removed_tags,
                merged.base_revision,
                next_revision,
                &payload.updated_at,
                &payload.updated_by,
                payload.writer_pid,
            ).map_err(|error| error.to_string())?;
            let payload_json = serde_json::json!({
                "tagNames": &merged.tag_names,
                "favorite": merged.favorite,
                "deleteProtected": merged.delete_protected,
                "mergePolicy": row.merge_policy,
                "baseRevision": merged.base_revision,
                "nextRevision": next_revision,
            }).to_string();
            event_insert.execute(params![
                normalize_event_type(&row.event_type),
                font_id,
                &row.relative_path,
                &payload_json,
                &payload.updated_at,
                &payload.updated_by,
                payload.writer_pid,
            ]).map_err(|error| error.to_string())?;
            changed_ids.push(font_id.to_string());
            written += 1;
            events += 1;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    set_meta(&conn, "updatedAt", &payload.updated_at).map_err(|error| error.to_string())?;
    set_meta(&conn, "writerHost", &payload.updated_by).map_err(|error| error.to_string())?;
    if !payload.root_path.trim().is_empty() {
        set_meta(&conn, "rootPath", &payload.root_path).map_err(|error| error.to_string())?;
    }
    changed_ids.sort();
    changed_ids.dedup();
    let signature = shared_metadata_signature_for_conn(&conn).map_err(|error| error.to_string())?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

    let timings = SharedMetadataTimings {
        elapsed: started_at.elapsed().as_millis(),
        rows: payload.rows.len(),
    };
    let state_signal = mutation_state_signal(
        "apply",
        &payload.db_path,
        &payload.root_path,
        &payload.updated_at,
        &changed_ids,
        &signature,
    );
    let mutation_protocol = tag_mutation_protocol_result(
        "--shared-metadata-apply",
        "sharedMetadata",
        "apply",
        "rust-worker",
        &changed_ids,
        &payload.updated_at,
        &payload.db_path,
        &payload.root_path,
        &[],
        &signature,
        state_signal.cache_invalidated,
        state_signal.merged_index_dirty,
        state_signal.page_query_dirty,
        state_signal.metrics_dirty,
        json_value(&state_signal),
        json_value(&timings),
        "rust-shared-metadata-apply",
    );
    let result = SharedMetadataApplyResult {
        ok: true,
        written,
        events,
        changed_ids: changed_ids.clone(),
        signature: signature.clone(),
        state_signal,
        mutation_protocol,
        timings,
        worker_mode: "rust-shared-metadata-apply".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn remove_shared_metadata_tag_state_machine(config: &SharedMetadataCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: SharedMetadataRemoveTagPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let tag_name = payload.tag_name.trim().to_string();
    if tag_name.is_empty() {
        let signature = "metadata:none".to_string();
        let timings = SharedMetadataTimings { elapsed: started_at.elapsed().as_millis(), rows: 0 };
        let state_signal = mutation_state_signal("removeTag", &payload.db_path, &payload.root_path, &payload.updated_at, &[], &signature);
        let mutation_protocol = tag_mutation_protocol_result(
            "--shared-metadata-remove-tag",
            "sharedMetadata",
            "removeTag",
            "rust-worker",
            &[],
            &payload.updated_at,
            &payload.db_path,
            &payload.root_path,
            &[],
            &signature,
            state_signal.cache_invalidated,
            state_signal.merged_index_dirty,
            state_signal.page_query_dirty,
            state_signal.metrics_dirty,
            json_value(&state_signal),
            json_value(&timings),
            "rust-shared-metadata-remove-tag",
        );
        let result = SharedMetadataRemoveTagResult {
            ok: true,
            updated_ids: Vec::new(),
            updated: 0,
            signature,
            state_signal,
            mutation_protocol,
            timings,
            worker_mode: "rust-shared-metadata-remove-tag".to_string(),
        };
        return serde_json::to_string(&result).map_err(|error| error.to_string());
    }

    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_shared_metadata_db(&conn).map_err(|error| error.to_string())?;
    let targets = find_targets(&conn, &tag_name).map_err(|error| error.to_string())?;
    if targets.is_empty() {
        let signature = shared_metadata_signature_for_conn(&conn).map_err(|error| error.to_string())?;
        let timings = SharedMetadataTimings { elapsed: started_at.elapsed().as_millis(), rows: 0 };
        let state_signal = mutation_state_signal("removeTag", &payload.db_path, &payload.root_path, &payload.updated_at, &[], &signature);
        let mutation_protocol = tag_mutation_protocol_result(
            "--shared-metadata-remove-tag",
            "sharedMetadata",
            "removeTag",
            "rust-worker",
            &[],
            &payload.updated_at,
            &payload.db_path,
            &payload.root_path,
            &[],
            &signature,
            state_signal.cache_invalidated,
            state_signal.merged_index_dirty,
            state_signal.page_query_dirty,
            state_signal.metrics_dirty,
            json_value(&state_signal),
            json_value(&timings),
            "rust-shared-metadata-remove-tag",
        );
        let result = SharedMetadataRemoveTagResult {
            ok: true,
            updated_ids: Vec::new(),
            updated: 0,
            signature: signature.clone(),
            state_signal,
            mutation_protocol,
            timings,
            worker_mode: "rust-shared-metadata-remove-tag".to_string(),
        };
        return serde_json::to_string(&result).map_err(|error| error.to_string());
    }

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut updated_ids = Vec::with_capacity(targets.len());
    {
        let mut update = tx.prepare(
            "UPDATE font_metadata
             SET tag_names_json = ?, revision = COALESCE(revision, 0) + 1, updated_at = ?, updated_by = ?
             WHERE font_id = ?"
        ).map_err(|error| error.to_string())?;
        let mut event_insert = tx.prepare(
            "INSERT INTO metadata_events (event_type, font_id, relative_path, payload_json, created_at, writer_host, writer_pid)
             VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).map_err(|error| error.to_string())?;
        let mut tag_op_insert = tx.prepare(
            "INSERT OR IGNORE INTO shared_tag_ops (
               op_id, font_id, relative_path, path_key, action, tag_name, base_revision, next_revision, created_at, machine_id, writer_pid, tombstone
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).map_err(|error| error.to_string())?;
        for target in &targets {
            let next_tags_json = serde_json::to_string(&target.next_tags).unwrap_or_else(|_| "[]".to_string());
            update.execute(params![&next_tags_json, &payload.updated_at, &payload.updated_by, &target.font_id])
                .map_err(|error| error.to_string())?;
            let next_revision = if target.revision > 0 { target.revision + 1 } else { 1 };
            insert_tag_ops(
                &mut tag_op_insert,
                &target.font_id,
                &target.relative_path,
                &target.path_key,
                &[],
                &vec![tag_name.clone()],
                target.revision,
                next_revision,
                &payload.updated_at,
                &payload.updated_by,
                payload.writer_pid,
            ).map_err(|error| error.to_string())?;
            let event_payload = serde_json::json!({ "tagName": tag_name, "previousTags": &target.previous_tags, "nextTags": &target.next_tags, "baseRevision": target.revision, "nextRevision": next_revision });
            let event_payload_json = event_payload.to_string();
            event_insert.execute(params![
                "delete_tag",
                &target.font_id,
                &target.relative_path,
                &event_payload_json,
                &payload.updated_at,
                &payload.updated_by,
                payload.writer_pid,
            ]).map_err(|error| error.to_string())?;
            updated_ids.push(target.font_id.clone());
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    set_meta(&conn, "updatedAt", &payload.updated_at).map_err(|error| error.to_string())?;
    set_meta(&conn, "writerHost", &payload.updated_by).map_err(|error| error.to_string())?;
    if !payload.root_path.trim().is_empty() {
        set_meta(&conn, "rootPath", &payload.root_path).map_err(|error| error.to_string())?;
    }

    updated_ids.sort();
    updated_ids.dedup();
    let signature = shared_metadata_signature_for_conn(&conn).map_err(|error| error.to_string())?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

    let timings = SharedMetadataTimings {
        elapsed: started_at.elapsed().as_millis(),
        rows: targets.len(),
    };
    let state_signal = mutation_state_signal("removeTag", &payload.db_path, &payload.root_path, &payload.updated_at, &updated_ids, &signature);
    let mutation_protocol = tag_mutation_protocol_result(
        "--shared-metadata-remove-tag",
        "sharedMetadata",
        "removeTag",
        "rust-worker",
        &updated_ids,
        &payload.updated_at,
        &payload.db_path,
        &payload.root_path,
        &[],
        &signature,
        state_signal.cache_invalidated,
        state_signal.merged_index_dirty,
        state_signal.page_query_dirty,
        state_signal.metrics_dirty,
        json_value(&state_signal),
        json_value(&timings),
        "rust-shared-metadata-remove-tag",
    );
    let result = SharedMetadataRemoveTagResult {
        ok: true,
        updated: targets.len(),
        updated_ids: updated_ids.clone(),
        signature: signature.clone(),
        state_signal,
        mutation_protocol,
        timings,
        worker_mode: "rust-shared-metadata-remove-tag".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn find_targets(conn: &Connection, tag_name: &str) -> rusqlite::Result<Vec<TagTarget>> {
    let mut stmt = conn.prepare(
        "SELECT font_id, COALESCE(relative_path, ''), COALESCE(path_key, ''), COALESCE(tag_names_json, '[]'), COALESCE(revision, 0)
         FROM font_metadata"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
        ))
    })?;
    let mut targets = Vec::new();
    for row in rows {
        let (font_id, relative_path, path_key, tag_names_json, revision) = row?;
        let tags = parse_tags(&tag_names_json);
        if !tags.iter().any(|tag| tag == tag_name) {
            continue;
        }
        let next_tags = tags.iter().filter(|tag| *tag != tag_name).cloned().collect::<Vec<_>>();
        targets.push(TagTarget { font_id, relative_path, path_key, previous_tags: tags, next_tags, revision });
    }
    Ok(targets)
}


fn normalize_event_type(value: &str) -> &str {
    match value {
        "update" | "delete_tag" => value,
        _ => "update",
    }
}

fn parse_tags(value: &str) -> Vec<String> {
    let Ok(serde_json::Value::Array(items)) = serde_json::from_str::<serde_json::Value>(value) else {
        return Vec::new();
    };
    let mut tags = items
        .into_iter()
        .filter_map(|item| match item {
            serde_json::Value::String(tag) => Some(tag.trim().to_string()),
            serde_json::Value::Number(number) => Some(number.to_string()),
            serde_json::Value::Bool(flag) => Some(flag.to_string()),
            _ => None,
        })
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    tags
}

fn tag_difference(left: &[String], right: &[String]) -> Vec<String> {
    let right_set = right.iter().cloned().collect::<std::collections::HashSet<_>>();
    left.iter()
        .filter(|tag| !right_set.contains(*tag))
        .cloned()
        .collect::<Vec<_>>()
}

fn merge_tag_lists(existing: &[String], added: &[String], removed: &[String]) -> Vec<String> {
    let removed_set = removed.iter().cloned().collect::<std::collections::HashSet<_>>();
    let mut tags = existing
        .iter()
        .filter(|tag| !removed_set.contains(*tag))
        .cloned()
        .chain(added.iter().cloned())
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    tags
}

fn same_tag_names(left: &[String], right: &[String]) -> bool {
    let mut left_tags = left.to_vec();
    let mut right_tags = right.to_vec();
    left_tags.sort();
    left_tags.dedup();
    right_tags.sort();
    right_tags.dedup();
    left_tags == right_tags
}

fn metadata_state_unchanged(existing: Option<&ExistingMetadataState>, merged: &MergedMetadataState) -> bool {
    match existing {
        Some(state) => {
            same_tag_names(&state.tag_names, &merged.tag_names)
                && state.favorite == merged.favorite
                && state.delete_protected == merged.delete_protected
        }
        None => merged.tag_names.is_empty() && !merged.favorite && !merged.delete_protected,
    }
}

fn merge_metadata_state(
    policy: &str,
    existing: Option<ExistingMetadataState>,
    base_tags: &[String],
    requested_tags: &[String],
    requested_favorite: bool,
    requested_delete_protected: bool,
) -> MergedMetadataState {
    let existing_state = existing.unwrap_or(ExistingMetadataState {
        tag_names: base_tags.to_vec(),
        favorite: requested_favorite,
        delete_protected: requested_delete_protected,
        revision: 0,
    });
    match policy {
        "tags" => {
            let added_tags = tag_difference(requested_tags, base_tags);
            let removed_tags = tag_difference(base_tags, requested_tags);
            let tag_names = merge_tag_lists(&existing_state.tag_names, &added_tags, &removed_tags);
            MergedMetadataState {
                tag_names,
                favorite: existing_state.favorite,
                delete_protected: existing_state.delete_protected,
                added_tags,
                removed_tags,
                base_revision: existing_state.revision,
            }
        }
        "favorite" => MergedMetadataState {
            tag_names: existing_state.tag_names,
            favorite: requested_favorite,
            delete_protected: existing_state.delete_protected,
            added_tags: Vec::new(),
            removed_tags: Vec::new(),
            base_revision: existing_state.revision,
        },
        "deleteProtected" => MergedMetadataState {
            tag_names: existing_state.tag_names,
            favorite: existing_state.favorite,
            delete_protected: requested_delete_protected,
            added_tags: Vec::new(),
            removed_tags: Vec::new(),
            base_revision: existing_state.revision,
        },
        _ => MergedMetadataState {
            tag_names: requested_tags.to_vec(),
            favorite: requested_favorite,
            delete_protected: requested_delete_protected,
            added_tags: tag_difference(requested_tags, base_tags),
            removed_tags: tag_difference(base_tags, requested_tags),
            base_revision: existing_state.revision,
        },
    }
}

fn next_tag_op_id() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let counter = TAG_OP_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", elapsed, std::process::id(), counter)
}

fn insert_tag_ops(
    stmt: &mut rusqlite::Statement<'_>,
    font_id: &str,
    relative_path: &str,
    path_key: &str,
    added_tags: &[String],
    removed_tags: &[String],
    base_revision: i64,
    next_revision: i64,
    created_at: &str,
    machine_id: &str,
    writer_pid: i64,
) -> rusqlite::Result<usize> {
    let mut written = 0usize;
    for tag_name in added_tags {
        written += stmt.execute(params![
            next_tag_op_id(), font_id, relative_path, path_key, "addTag", tag_name, base_revision, next_revision, created_at, machine_id, writer_pid, 0
        ])?;
    }
    for tag_name in removed_tags {
        written += stmt.execute(params![
            next_tag_op_id(), font_id, relative_path, path_key, "removeTag", tag_name, base_revision, next_revision, created_at, machine_id, writer_pid, 1
        ])?;
    }
    Ok(written)
}

fn mutation_state_signal(
    mutation_kind: &str,
    db_path: &str,
    root_path: &str,
    updated_at: &str,
    changed_ids: &[String],
    signature: &str,
) -> SharedMetadataMutationStateSignal {
    let changed = !changed_ids.is_empty();
    SharedMetadataMutationStateSignal {
        mutation_kind: mutation_kind.to_string(),
        db_path: db_path.to_string(),
        root_path: root_path.to_string(),
        changed_ids: changed_ids.to_vec(),
        updated_at: updated_at.to_string(),
        signature: signature.to_string(),
        shared_metadata_changed: changed,
        cache_invalidated: changed,
        merged_index_dirty: changed,
        page_query_dirty: changed,
        metrics_dirty: changed,
    }
}
