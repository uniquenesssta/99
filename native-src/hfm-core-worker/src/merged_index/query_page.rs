use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params_from_iter, Connection};
use serde_json::{json, Value};

use super::font_row::{font_from_merged_row, MergedRow};
use super::local_tags::hydrate_local_tags;
use super::snapshot::{register_shared_font_id, roots_snapshot_usable};
use super::tag_revision::merged_index_tag_revision_metadata;
use super::sqlite_params::json_to_sql_value;
use super::types::{MergedIndexPageQueryConfig, MergedIndexPageQueryPayload, MergedIndexPageQueryResult};

fn elapsed_ms(started_at: &Instant) -> u128 {
    started_at.elapsed().as_millis()
}

fn elapsed_since(started_at: Instant) -> u128 {
    started_at.elapsed().as_millis()
}

fn sqlite_literal(value: &str) -> String {
    format!("'{}'", value.replace("'", "''"))
}

fn needs_local_db(payload: &MergedIndexPageQueryPayload) -> bool {
    payload.sql.sql.to_lowercase().contains("local_db.")
        || payload.sql.count_sql.to_lowercase().contains("local_db.")
}

fn json_output(
    payload: &MergedIndexPageQueryPayload,
    items: Vec<Value>,
    total: i64,
    timings: BTreeMap<&str, u128>,
    tag_revision: Value,
    started_at: &Instant,
) -> Result<String, String> {
    let keyword = payload.request.get("keyword").and_then(Value::as_str).unwrap_or("");
    let item_count = items.len() as i64;
    let result = json!({
        "ok": true,
        "queryKey": payload.query_key.clone(),
        "items": items,
        "total": total,
        "offset": payload.offset,
        "limit": payload.limit,
        "truncated": payload.offset + item_count < total,
        "engine": if payload.sql.used_like || !keyword.is_empty() { "like" } else { "sql" },
        "elapsedMs": elapsed_ms(started_at),
        "workerMode": "rust-merged-index-page",
        "tagRevision": tag_revision,
        "timings": timings,
    });
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn query_merged_index_page(config: &MergedIndexPageQueryConfig) -> Result<MergedIndexPageQueryResult, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: MergedIndexPageQueryPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
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
    let mut local_attached = false;
    let attach_started_at = Instant::now();
    match conn.execute_batch(&format!("ATTACH DATABASE {} AS local_db", sqlite_literal(&payload.library_db_path))) {
        Ok(_) => {
            local_attached = true;
            timings.insert("attachLocal", elapsed_since(attach_started_at));
        }
        Err(error) => {
            if local_needed {
                return Err(error.to_string());
            }
        }
    }
    let _ = conn.execute_batch("PRAGMA query_only = true");

    let count_started_at = Instant::now();
    let count_params = payload.sql.count_params.iter().map(json_to_sql_value).collect::<Vec<_>>();
    let total_row: i64 = conn
        .query_row(&payload.sql.count_sql, params_from_iter(count_params), |row| row.get::<_, i64>(0))
        .map_err(|error| error.to_string())?;
    timings.insert("count", elapsed_since(count_started_at));

    let select_started_at = Instant::now();
    let select_params = payload.sql.params.iter().map(json_to_sql_value).collect::<Vec<_>>();
    let mut stmt = conn.prepare(&payload.sql.sql).map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(select_params), MergedRow::from_row)
        .map_err(|error| error.to_string())?;
    let merged_rows = rows.filter_map(Result::ok).collect::<Vec<_>>();
    timings.insert("select", elapsed_since(select_started_at));

    let mut total = total_row;
    if total == 0 && !merged_rows.is_empty() {
        total = merged_rows.len() as i64;
    }

    let parse_started_at = Instant::now();
    let mut items = merged_rows
        .iter()
        .filter_map(font_from_merged_row)
        .collect::<Vec<_>>();
    timings.insert("parse", elapsed_since(parse_started_at));

    if local_attached && !items.is_empty() {
        let local_started_at = Instant::now();
        items = hydrate_local_tags(&conn, items);
        timings.insert("localTags", elapsed_since(local_started_at));
    }

    Ok(MergedIndexPageQueryResult {
        json: json_output(
            &payload,
            items,
            total,
            timings,
            merged_index_tag_revision_metadata(&conn, &payload.library_db_path, &payload.tag_revision),
            &started_at,
        )?,
    })
}
