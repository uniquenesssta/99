use std::collections::BTreeSet;
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params, Connection};

use crate::mutation_protocol::{json_value, tag_mutation_protocol_result};

use super::catalog::{
    clean_tag_names, known_tag_diff, merge_tag_sets, read_bound_tags, read_known_tags,
    remove_known_tag, retained_empty_tags, save_known_tags,
};
use super::schema::{initialize_local_tags_db, set_meta};
use super::types::{
    LocalTagsCommandConfig, LocalTagsDeletePayload, LocalTagsDeleteResult,
    LocalTagsMutationStateSignal, LocalTagsSetPayload, LocalTagsSetResult, LocalTagsTimings,
};

pub fn set_local_tags_state_machine(config: &LocalTagsCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: LocalTagsSetPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_local_tags_db(&conn).map_err(|error| error.to_string())?;
    let previous_known_tags = read_known_tags(&conn).map_err(|error| error.to_string())?;
    let previous_bound_tags = read_bound_tags(&conn).map_err(|error| error.to_string())?;
    let requested_tags = clean_tag_names(
        &payload.rows.iter().flat_map(|row| row.tag_names.clone()).collect::<Vec<_>>(),
    );

    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut updated_ids: Vec<String> = Vec::new();
    let mut written = 0usize;
    {
        let delete_by_id = tx.prepare("DELETE FROM local_font_tags WHERE font_id = ?").map_err(|error| error.to_string())?;
        let delete_by_path = tx.prepare("DELETE FROM local_font_tags WHERE font_path = ?").map_err(|error| error.to_string())?;
        let insert = tx.prepare(
            "INSERT OR REPLACE INTO local_font_tags (font_id, font_path, tag_name, updated_at)
             VALUES (?, ?, ?, ?)"
        ).map_err(|error| error.to_string())?;
        apply_set_rows(delete_by_id, delete_by_path, insert, &payload, &mut updated_ids, &mut written)?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    let next_bound_tags = read_bound_tags(&conn).map_err(|error| error.to_string())?;
    let known_tags = merge_tag_sets([
        previous_known_tags.as_slice(),
        next_bound_tags.as_slice(),
        requested_tags.as_slice(),
    ]);
    let retained_empty_tags = retained_empty_tags(&previous_bound_tags, &next_bound_tags, &known_tags);
    let (added_known_tags, removed_known_tags) = known_tag_diff(&previous_known_tags, &known_tags);
    save_known_tags(&conn, &known_tags).map_err(|error| error.to_string())?;
    set_meta(&conn, "localTagsUpdatedAt", &payload.updated_at).map_err(|error| error.to_string())?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

    updated_ids.sort();
    updated_ids.dedup();
    let timings = LocalTagsTimings { elapsed: started_at.elapsed().as_millis(), rows: payload.rows.len() };
    let catalog_changed = !added_known_tags.is_empty() || !removed_known_tags.is_empty();
    let state_signal = local_tag_signal("set", &payload.db_path, &payload.updated_at, &updated_ids, &known_tags, catalog_changed);
    let mutation_protocol = tag_mutation_protocol_result(
        "--local-tags-set",
        "localTags",
        "set",
        "rust-worker",
        &updated_ids,
        &payload.updated_at,
        &payload.db_path,
        "",
        &known_tags,
        "",
        state_signal.cache_invalidated,
        false,
        state_signal.page_query_dirty,
        state_signal.metrics_dirty,
        json_value(&state_signal),
        json_value(&timings),
        "rust-local-tags-set",
    );
    let result = LocalTagsSetResult {
        ok: true,
        written,
        updated_ids: updated_ids.clone(),
        previous_known_tags,
        known_tags,
        added_known_tags,
        removed_known_tags,
        retained_empty_tags,
        state_signal,
        mutation_protocol,
        timings,
        worker_mode: "rust-local-tags-set".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn apply_set_rows(
    mut delete_by_id: rusqlite::Statement<'_>,
    mut delete_by_path: rusqlite::Statement<'_>,
    mut insert: rusqlite::Statement<'_>,
    payload: &LocalTagsSetPayload,
    updated_ids: &mut Vec<String>,
    written: &mut usize,
) -> Result<(), String> {
    for row in &payload.rows {
        let aliases = clean_aliases(&row.aliases);
        if aliases.is_empty() {
            continue;
        }
        let font_path = normalize_font_path(&row.font_path);
        for alias in &aliases {
            delete_by_id.execute(params![alias]).map_err(|error| error.to_string())?;
        }
        if !font_path.is_empty() {
            delete_by_path.execute(params![&font_path]).map_err(|error| error.to_string())?;
        }
        let tag_names = clean_tag_names(&row.tag_names);
        for alias in &aliases {
            for tag_name in &tag_names {
                insert.execute(params![alias, &font_path, tag_name, &payload.updated_at]).map_err(|error| error.to_string())?;
                *written += 1;
            }
        }
        let item_id = row.item_id.trim();
        if item_id.is_empty() {
            updated_ids.extend(aliases.iter().cloned());
        } else {
            updated_ids.push(item_id.to_string());
        }
    }
    Ok(())
}

pub fn delete_local_tag_state_machine(config: &LocalTagsCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: LocalTagsDeletePayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let tag_name = payload.tag_name.trim().to_string();
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_local_tags_db(&conn).map_err(|error| error.to_string())?;
    let previous_known_tags = read_known_tags(&conn).map_err(|error| error.to_string())?;

    let mut updated_ids = if tag_name.is_empty() {
        Vec::new()
    } else {
        read_tag_target_ids(&conn, &tag_name).map_err(|error| error.to_string())?
    };
    let updated = updated_ids.len();
    if !tag_name.is_empty() {
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        tx.execute("DELETE FROM local_font_tags WHERE tag_name = ?", params![&tag_name])
            .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
    }
    let known_tags = remove_known_tag(&previous_known_tags, &tag_name);
    let (added_known_tags, removed_known_tags) = known_tag_diff(&previous_known_tags, &known_tags);
    save_known_tags(&conn, &known_tags).map_err(|error| error.to_string())?;
    set_meta(&conn, "localTagsUpdatedAt", &payload.updated_at).map_err(|error| error.to_string())?;
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");

    updated_ids.sort();
    updated_ids.dedup();
    let timings = LocalTagsTimings { elapsed: started_at.elapsed().as_millis(), rows: updated };
    let catalog_changed = !added_known_tags.is_empty() || !removed_known_tags.is_empty();
    let state_signal = local_tag_signal("deleteTag", &payload.db_path, &payload.updated_at, &updated_ids, &known_tags, catalog_changed);
    let mutation_protocol = tag_mutation_protocol_result(
        "--local-tags-delete-tag",
        "localTags",
        "deleteTag",
        "rust-worker",
        &updated_ids,
        &payload.updated_at,
        &payload.db_path,
        "",
        &known_tags,
        "",
        state_signal.cache_invalidated,
        false,
        state_signal.page_query_dirty,
        state_signal.metrics_dirty,
        json_value(&state_signal),
        json_value(&timings),
        "rust-local-tags-delete",
    );
    let result = LocalTagsDeleteResult {
        ok: true,
        updated,
        updated_ids: updated_ids.clone(),
        previous_known_tags,
        known_tags,
        added_known_tags,
        removed_known_tags,
        state_signal,
        mutation_protocol,
        timings,
        worker_mode: "rust-local-tags-delete".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn read_tag_target_ids(conn: &Connection, tag_name: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT font_id, font_path FROM local_font_tags WHERE tag_name = ?")?;
    let rows = stmt.query_map(params![tag_name], |row| {
        let font_id: String = row.get(0)?;
        let font_path: String = row.get(1)?;
        Ok((font_id, font_path))
    })?;
    let mut ids = Vec::new();
    for row in rows {
        let (font_id, font_path) = row?;
        if !font_id.trim().is_empty() {
            ids.push(font_id);
        } else if !font_path.trim().is_empty() {
            ids.push(font_path);
        }
    }
    Ok(ids)
}

fn clean_aliases(values: &[String]) -> Vec<String> {
    let mut set = BTreeSet::new();
    for value in values {
        let item = value.trim();
        if !item.is_empty() {
            set.insert(item.to_string());
        }
    }
    set.into_iter().collect()
}

fn normalize_font_path(value: &str) -> String {
    let mut path = value.trim().replace('/', "\\").to_lowercase();
    while path.ends_with('\\') {
        path.pop();
    }
    path
}

fn local_tag_signal(
    kind: &str,
    db_path: &str,
    updated_at: &str,
    changed_ids: &[String],
    known_tags: &[String],
    catalog_changed: bool,
) -> LocalTagsMutationStateSignal {
    let changed = !changed_ids.is_empty() || catalog_changed;
    LocalTagsMutationStateSignal {
        mutation_kind: kind.to_string(),
        db_path: db_path.to_string(),
        changed_ids: changed_ids.to_vec(),
        updated_at: updated_at.to_string(),
        local_tags_changed: changed,
        cache_invalidated: changed,
        page_query_dirty: changed,
        metrics_dirty: changed,
        known_tags: known_tags.to_vec(),
    }
}
