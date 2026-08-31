use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};

use super::path::normalize_path_for_cache_compare;
use super::schema::initialize_preview_cache_db;
use super::types::{PreviewCacheCommandConfig, PreviewCacheQueryMatch, PreviewCacheQueryPayload, PreviewCacheQueryResult, PreviewCacheReadStatusPayload, PreviewCacheReadStatusResult, PreviewCacheTimings, PreviewCacheTouchPayload, PreviewCacheTouchResult};

pub fn read_preview_cache_status(config: &PreviewCacheCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: PreviewCacheReadStatusPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_preview_cache_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    let row = select_status_row(&conn, &payload.preview_key).map_err(|error| error.to_string())?;
    let mut status = None;
    let mut matched = false;
    let mut touched = false;
    if let Some((output_path, raw_status)) = row {
        let normalized_status = normalize_status(raw_status.as_deref());
        matched = normalize_path_for_cache_compare(&output_path) == normalize_path_for_cache_compare(&payload.output_path);
        if matched {
            status = normalized_status;
            if status.is_some() {
                conn.execute(
                    "UPDATE preview_cache SET accessed_at = ?, updated_at = ? WHERE preview_key = ?",
                    params![&payload.now, &payload.now, &payload.preview_key],
                ).map_err(|error| error.to_string())?;
                touched = true;
            }
        }
    }

    let result = PreviewCacheReadStatusResult {
        ok: true,
        status,
        matched,
        touched,
        timings: PreviewCacheTimings { elapsed: started_at.elapsed().as_millis(), rows: 1 },
        worker_mode: "rust-preview-cache-read-status".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn query_preview_cache_status(config: &PreviewCacheCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: PreviewCacheQueryPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_preview_cache_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    let accepted = accepted_status_set(&payload.accepted_statuses);
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut rows = Vec::with_capacity(payload.rows.len());
    let mut matched_count = 0usize;
    let mut touch_keys = Vec::new();
    {
        let mut select = tx.prepare("SELECT output_path, status FROM preview_cache WHERE preview_key = ?").map_err(|error| error.to_string())?;
        for row in &payload.rows {
            let selected = select.query_row(params![&row.preview_key], |db_row| {
                Ok((db_row.get::<_, String>(0)?, db_row.get::<_, Option<String>>(1)?))
            }).optional().map_err(|error| error.to_string())?;
            let mut status = None;
            let mut matched = false;
            if let Some((output_path, raw_status)) = selected {
                let normalized_status = normalize_status(raw_status.as_deref());
                let status_accepted = normalized_status.as_deref().map(|value| accepted.contains(value)).unwrap_or(false);
                matched = status_accepted && normalize_path_for_cache_compare(&output_path) == normalize_path_for_cache_compare(&row.output_path);
                if matched {
                    matched_count += 1;
                    if payload.touch_matched {
                        touch_keys.push(row.preview_key.clone());
                    }
                }
                status = normalized_status;
            }
            rows.push(PreviewCacheQueryMatch {
                id: row.id.clone(),
                preview_key: row.preview_key.clone(),
                output_path: row.output_path.clone(),
                status,
                matched,
            });
        }
    }
    let touched = touch_keys.len();
    if payload.touch_matched && !touch_keys.is_empty() {
        let mut touch = tx.prepare("UPDATE preview_cache SET accessed_at = ?, updated_at = ? WHERE preview_key = ?").map_err(|error| error.to_string())?;
        for key in &touch_keys {
            touch.execute(params![&payload.now, &payload.now, key]).map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;

    let result = PreviewCacheQueryResult {
        ok: true,
        rows,
        matched: matched_count,
        touched,
        timings: PreviewCacheTimings { elapsed: started_at.elapsed().as_millis(), rows: payload.rows.len() },
        worker_mode: "rust-preview-cache-query".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn touch_preview_cache_rows(config: &PreviewCacheCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: PreviewCacheTouchPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_preview_cache_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut touched = 0usize;
    {
        let mut stmt = tx.prepare("UPDATE preview_cache SET accessed_at = ?, updated_at = ? WHERE preview_key = ?").map_err(|error| error.to_string())?;
        for key in &payload.keys {
            if key.trim().is_empty() {
                continue;
            }
            touched += stmt.execute(params![&payload.now, &payload.now, key]).map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;

    let result = PreviewCacheTouchResult {
        ok: true,
        touched,
        timings: PreviewCacheTimings { elapsed: started_at.elapsed().as_millis(), rows: payload.keys.len() },
        worker_mode: "rust-preview-cache-touch".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn select_status_row(conn: &Connection, preview_key: &str) -> rusqlite::Result<Option<(String, Option<String>)>> {
    conn.query_row(
        "SELECT output_path, status FROM preview_cache WHERE preview_key = ?",
        params![preview_key],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
    ).optional()
}

pub(crate) fn normalize_status(value: Option<&str>) -> Option<String> {
    match value.unwrap_or_default() {
        "ok" | "missing" | "failed" | "pending" | "generating" | "stale" => Some(value.unwrap_or_default().to_string()),
        _ => None,
    }
}

pub(crate) fn accepted_status_set(values: &[String]) -> HashSet<String> {
    let mut set = HashSet::new();
    for value in values {
        if normalize_status(Some(value.as_str())).is_some() {
            set.insert(value.to_string());
        }
    }
    if set.is_empty() {
        set.insert("ok".to_string());
    }
    set
}
