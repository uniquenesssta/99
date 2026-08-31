use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params, Connection};

use super::schema::{initialize_preview_cache_db, set_meta};
use super::types::{PreviewCacheApplyPayload, PreviewCacheApplyResult, PreviewCacheCommandConfig, PreviewCacheDeletePayload, PreviewCacheDeleteResult, PreviewCacheTimings};

pub fn apply_preview_cache_rows(config: &PreviewCacheCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: PreviewCacheApplyPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_preview_cache_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut written = 0usize;
    {
        let mut upsert = tx.prepare(
            "INSERT INTO preview_cache (
               preview_key, font_id, source_path, root_path, relative_path, output_path,
               font_signature, text_hash, font_size, width, height, storage, status,
               message, fail_count, generated_at, accessed_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(preview_key) DO UPDATE SET
               font_id = COALESCE(excluded.font_id, preview_cache.font_id),
               source_path = COALESCE(excluded.source_path, preview_cache.source_path),
               root_path = COALESCE(excluded.root_path, preview_cache.root_path),
               relative_path = excluded.relative_path,
               output_path = excluded.output_path,
               font_signature = excluded.font_signature,
               text_hash = excluded.text_hash,
               font_size = excluded.font_size,
               width = excluded.width,
               height = excluded.height,
               storage = excluded.storage,
               status = excluded.status,
               message = excluded.message,
               fail_count = MAX(COALESCE(preview_cache.fail_count, 0), excluded.fail_count),
               generated_at = COALESCE(excluded.generated_at, preview_cache.generated_at),
               accessed_at = COALESCE(excluded.accessed_at, preview_cache.accessed_at),
               updated_at = excluded.updated_at"
        ).map_err(|error| error.to_string())?;

        for row in &payload.rows {
            if row.preview_key.trim().is_empty() || row.output_path.trim().is_empty() {
                continue;
            }
            upsert.execute(params![
                &row.preview_key,
                row.font_id.as_deref(),
                row.source_path.as_deref(),
                row.root_path.as_deref(),
                &row.relative_path,
                &row.output_path,
                &row.font_signature,
                &row.text_hash,
                row.font_size,
                row.width,
                row.height,
                &row.storage,
                normalize_status(&row.status),
                row.message.as_deref(),
                row.fail_count.max(0),
                row.generated_at.as_deref(),
                row.accessed_at.as_deref(),
                &row.updated_at,
            ]).map_err(|error| error.to_string())?;
            written += 1;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;
    if let Some(first) = payload.rows.first() {
        set_meta(&conn, "updatedAt", &first.updated_at).map_err(|error| error.to_string())?;
    }

    let result = PreviewCacheApplyResult {
        ok: true,
        written,
        timings: PreviewCacheTimings { elapsed: started_at.elapsed().as_millis(), rows: payload.rows.len() },
        worker_mode: "rust-preview-cache-apply".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn delete_preview_cache_rows(config: &PreviewCacheCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: PreviewCacheDeletePayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_preview_cache_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let mut deleted = 0usize;
    {
        let mut stmt = tx.prepare("DELETE FROM preview_cache WHERE preview_key = ?").map_err(|error| error.to_string())?;
        for key in &payload.keys {
            if key.trim().is_empty() {
                continue;
            }
            deleted += stmt.execute(params![key]).map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())?;

    let result = PreviewCacheDeleteResult {
        ok: true,
        deleted,
        timings: PreviewCacheTimings { elapsed: started_at.elapsed().as_millis(), rows: payload.keys.len() },
        worker_mode: "rust-preview-cache-delete".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn normalize_status(value: &str) -> &str {
    match value {
        "ok" | "missing" | "failed" | "pending" | "generating" | "stale" => value,
        _ => "pending",
    }
}
