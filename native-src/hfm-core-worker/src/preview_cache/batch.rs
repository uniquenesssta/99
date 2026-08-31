use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params, Connection, OptionalExtension};

use super::path::normalize_path_for_cache_compare;
use super::schema::initialize_preview_cache_db;
use super::status::{accepted_status_set, normalize_status};
use super::types::{
    PreviewCacheBatchMatch, PreviewCacheBatchPayload, PreviewCacheBatchResult,
    PreviewCacheCommandConfig, PreviewCacheTimings,
};

pub fn query_preview_cache_batch(config: &PreviewCacheCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: PreviewCacheBatchPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_preview_cache_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    let accepted = accepted_status_set(&payload.accepted_statuses);
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut rows = Vec::with_capacity(payload.rows.len());
    let mut matched_count = 0usize;
    let mut missing_ids = Vec::new();
    let mut touch_keys = Vec::new();
    let mut existing_file_cache: HashSet<String> = HashSet::new();
    let mut missing_file_cache: HashSet<String> = HashSet::new();

    {
        let mut select = tx.prepare("SELECT output_path, status FROM preview_cache WHERE preview_key = ?").map_err(|error| error.to_string())?;
        for row in &payload.rows {
            let selected = select.query_row(params![&row.preview_key], |db_row| {
                Ok((db_row.get::<_, String>(0)?, db_row.get::<_, Option<String>>(1)?))
            }).optional().map_err(|error| error.to_string())?;

            let mut status = None;
            let mut matched = false;
            let mut file_exists = false;
            if let Some((output_path, raw_status)) = selected {
                let normalized_status = normalize_status(raw_status.as_deref());
                let status_accepted = normalized_status.as_deref().map(|value| accepted.contains(value)).unwrap_or(false);
                let path_matched = normalize_path_for_cache_compare(&output_path) == normalize_path_for_cache_compare(&row.output_path);
                if status_accepted && path_matched {
                    file_exists = if payload.check_files {
                        cached_file_exists(&row.output_path, &mut existing_file_cache, &mut missing_file_cache)
                    } else {
                        true
                    };
                    matched = file_exists;
                    if matched {
                        matched_count += 1;
                        if payload.touch_matched {
                            touch_keys.push(row.preview_key.clone());
                        }
                    }
                }
                status = normalized_status;
            }

            if !matched {
                missing_ids.push(row.id.clone());
            }
            rows.push(PreviewCacheBatchMatch {
                id: row.id.clone(),
                preview_key: row.preview_key.clone(),
                output_path: row.output_path.clone(),
                status,
                matched,
                file_exists,
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

    let result = PreviewCacheBatchResult {
        ok: true,
        rows,
        matched: matched_count,
        touched,
        missing_ids,
        timings: PreviewCacheTimings { elapsed: started_at.elapsed().as_millis(), rows: payload.rows.len() },
        worker_mode: "rust-preview-cache-batch".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn cached_file_exists(path: &str, existing: &mut HashSet<String>, missing: &mut HashSet<String>) -> bool {
    let key = normalize_path_for_cache_compare(path);
    if existing.contains(&key) {
        return true;
    }
    if missing.contains(&key) {
        return false;
    }
    match fs::metadata(path) {
        Ok(stat) if stat.is_file() => {
            existing.insert(key);
            true
        }
        _ => {
            missing.insert(key);
            false
        }
    }
}
