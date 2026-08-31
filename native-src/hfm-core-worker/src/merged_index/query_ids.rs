use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};

use super::snapshot::{register_shared_font_id, roots_snapshot_usable};
use super::tag_revision::merged_index_tag_revision_metadata;
use super::sqlite_params::json_to_sql_value;
use super::types::{MergedIndexIdsQueryConfig, MergedIndexIdsQueryPayload, MergedIndexIdsQueryResult};

fn elapsed_ms(started_at: &Instant) -> u128 {
    started_at.elapsed().as_millis()
}

fn elapsed_since(started_at: Instant) -> u128 {
    started_at.elapsed().as_millis()
}

fn sqlite_literal(value: &str) -> String {
    format!("'{}'", value.replace("'", "''"))
}

fn needs_local_db(payload: &MergedIndexIdsQueryPayload) -> bool {
    payload.sql.sql.to_lowercase().contains("local_db.")
}

fn json_output(
    payload: &MergedIndexIdsQueryPayload,
    ids: Vec<String>,
    timings: BTreeMap<&str, u128>,
    tag_revision: Value,
    started_at: &Instant,
) -> Result<String, String> {
    let keyword = payload.request.get("keyword").and_then(Value::as_str).unwrap_or("");
    let limit = payload.limit.max(1) as usize;
    let truncated = ids.len() > limit;
    let selected = ids.into_iter().take(limit).collect::<Vec<_>>();
    let total = selected.len();
    let result = json!({
        "ok": true,
        "queryKey": payload.query_key.clone(),
        "ids": selected,
        "total": total,
        "limit": payload.limit,
        "truncated": truncated,
        "engine": if payload.sql.used_like || !keyword.is_empty() { "like" } else { "sql" },
        "elapsedMs": elapsed_ms(started_at),
        "workerMode": "rust-merged-index-ids",
        "tagRevision": tag_revision,
        "timings": timings,
    });
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn query_merged_index_ids(config: &MergedIndexIdsQueryConfig) -> Result<MergedIndexIdsQueryResult, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: MergedIndexIdsQueryPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if !Path::new(&payload.merged_index_db_path).exists() {
        return Err("merged index database does not exist".to_string());
    }

    let open_started_at = Instant::now();
    let conn = Connection::open_with_flags(
        &payload.merged_index_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| error.to_string())?;
    let mut timings: BTreeMap<&str, u128> = BTreeMap::new();
    timings.insert("open", elapsed_since(open_started_at));

    register_shared_font_id(&conn).map_err(|error| error.to_string())?;
    if !roots_snapshot_usable(&conn, &payload.roots, payload.schema_version).map_err(|error| error.to_string())? {
        return Err("merged index snapshot is not usable".to_string());
    }

    let local_needed = needs_local_db(&payload);
    let attach_started_at = Instant::now();
    match conn.execute_batch(&format!("ATTACH DATABASE {} AS local_db", sqlite_literal(&payload.library_db_path))) {
        Ok(_) => {
            timings.insert("attachLocal", elapsed_since(attach_started_at));
        }
        Err(error) => {
            if local_needed {
                return Err(error.to_string());
            }
        }
    }
    let _ = conn.execute_batch("PRAGMA query_only = true");

    let select_started_at = Instant::now();
    let select_params = payload.sql.params.iter().map(json_to_sql_value).collect::<Vec<_>>();
    let mut stmt = conn.prepare(&payload.sql.sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(select_params), |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let ids = rows.filter_map(Result::ok).filter(|id| !id.is_empty()).collect::<Vec<_>>();
    timings.insert("select", elapsed_since(select_started_at));

    Ok(MergedIndexIdsQueryResult {
        json: json_output(
            &payload,
            ids,
            timings,
            merged_index_tag_revision_metadata(&conn, &payload.library_db_path, &payload.tag_revision),
            &started_at,
        )?,
    })
}
