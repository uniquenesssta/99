use std::collections::HashSet;
use std::fs;

use rusqlite::{params, Connection, OptionalExtension};

use crate::json::escape_json;

use super::path::{normalize_relative_path, normalized_extension, target_path};
use super::signature::{compute_directory_signature, directory_signature_matches, file_cache_signature, metadata_modified_ms};
use super::types::{DirectorySignature, WatcherPreflightConfig, WatcherPreflightInput, WatcherPreflightResult};

fn normalize_extensions(extensions: &[String]) -> HashSet<String> {
    extensions
        .iter()
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn read_directory_signature(conn: &Connection, relative_path: &str) -> rusqlite::Result<Option<DirectorySignature>> {
    conn.query_row(
        "SELECT modified_at, file_count, dir_count FROM directories WHERE relative_path = ?",
        params![relative_path],
        |row| {
            Ok(DirectorySignature {
                modified_at: row.get::<_, f64>(0)?,
                file_count: row.get::<_, i64>(1)?,
                dir_count: row.get::<_, i64>(2)?,
            })
        },
    )
    .optional()
}

fn file_entry_unchanged(conn: &Connection, relative_path: &str, cache_key: &str) -> rusqlite::Result<bool> {
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT cache_key, status FROM entries WHERE relative_path = ? AND COALESCE(is_deleted, 0) = 0",
            params![relative_path],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let Some((db_cache_key, status)) = row else {
        return Ok(false);
    };
    Ok(db_cache_key == cache_key && (status == "ok" || status == "bad"))
}

pub fn run_watcher_preflight(config: &WatcherPreflightConfig) -> Result<WatcherPreflightResult, String> {
    let input_text = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let input: WatcherPreflightInput = serde_json::from_str(&input_text).map_err(|error| error.to_string())?;
    if input.changes.is_empty() {
        return Ok(WatcherPreflightResult {
            unchanged: true,
            reason: "empty".to_string(),
            checked_files: 0,
            checked_dirs: 0,
        });
    }

    let extensions = normalize_extensions(&input.extensions);
    let conn = Connection::open(&input.db_path).map_err(|error| error.to_string())?;
    let mut checked_files = 0usize;
    let mut checked_dirs = 0usize;

    for change in &input.changes {
        if change.event_type.to_ascii_lowercase() != "change" {
            return Ok(WatcherPreflightResult {
                unchanged: false,
                reason: "event-type".to_string(),
                checked_files,
                checked_dirs,
            });
        }

        let relative_path = normalize_relative_path(&change.file_name);
        if relative_path.is_empty() {
            return Ok(WatcherPreflightResult {
                unchanged: false,
                reason: "root-change".to_string(),
                checked_files,
                checked_dirs,
            });
        }

        let path = target_path(&input.root_path, &relative_path);
        let metadata = match fs::metadata(&path) {
            Ok(value) => value,
            Err(_) => {
                return Ok(WatcherPreflightResult {
                    unchanged: false,
                    reason: "missing-target".to_string(),
                    checked_files,
                    checked_dirs,
                });
            }
        };

        if metadata.is_file() {
            if !extensions.contains(&normalized_extension(&path)) {
                return Ok(WatcherPreflightResult {
                    unchanged: false,
                    reason: "non-font-file".to_string(),
                    checked_files,
                    checked_dirs,
                });
            }
            let signature = file_cache_signature(&relative_path, metadata.len(), metadata_modified_ms(&metadata));
            if !file_entry_unchanged(&conn, &relative_path, &signature).map_err(|error| error.to_string())? {
                return Ok(WatcherPreflightResult {
                    unchanged: false,
                    reason: "file-changed".to_string(),
                    checked_files,
                    checked_dirs,
                });
            }
            checked_files += 1;
            continue;
        }

        if metadata.is_dir() {
            let current = match compute_directory_signature(&path) {
                Some(value) => value,
                None => {
                    return Ok(WatcherPreflightResult {
                        unchanged: false,
                        reason: "directory-signature".to_string(),
                        checked_files,
                        checked_dirs,
                    });
                }
            };
            let stored = read_directory_signature(&conn, &relative_path).map_err(|error| error.to_string())?;
            if !stored.as_ref().map(|value| directory_signature_matches(value, &current)).unwrap_or(false) {
                return Ok(WatcherPreflightResult {
                    unchanged: false,
                    reason: "directory-changed".to_string(),
                    checked_files,
                    checked_dirs,
                });
            }
            checked_dirs += 1;
            continue;
        }

        return Ok(WatcherPreflightResult {
            unchanged: false,
            reason: "unsupported-target".to_string(),
            checked_files,
            checked_dirs,
        });
    }

    Ok(WatcherPreflightResult {
        unchanged: true,
        reason: "matched".to_string(),
        checked_files,
        checked_dirs,
    })
}

pub fn watcher_preflight_to_json(result: &WatcherPreflightResult, elapsed_ms: u128) -> String {
    format!(
        "{{\"ok\":true,\"unchanged\":{},\"reason\":\"{}\",\"checkedFiles\":{},\"checkedDirs\":{},\"elapsedMs\":{}}}",
        if result.unchanged { "true" } else { "false" },
        escape_json(&result.reason),
        result.checked_files,
        result.checked_dirs,
        elapsed_ms
    )
}
