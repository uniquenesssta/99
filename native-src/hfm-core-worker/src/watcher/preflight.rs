use std::collections::HashSet;
use std::fs;

use rusqlite::{params, Connection, OptionalExtension};

use crate::json::escape_json;

use super::path::{normalize_relative_path, normalized_extension, target_path};
use super::signature::{file_cache_signature, metadata_modified_ms};
use super::types::{WatcherPreflightConfig, WatcherPreflightInput, WatcherPreflightResult};

fn normalize_extensions(extensions: &[String]) -> HashSet<String> {
    extensions
        .iter()
        .map(|value| value.trim().trim_start_matches('.').to_ascii_lowercase())
        .filter(|value| !value.is_empty())
        .collect()
}

fn file_entry_unchanged(conn: &Connection, relative_path: &str, cache_key: &str, script_version: Option<u64>) -> rusqlite::Result<bool> {
    let row: Option<(String, String, Option<String>)> = conn
        .query_row(
            "SELECT cache_key, status, font_json FROM entries WHERE relative_path = ? AND COALESCE(is_deleted, 0) = 0",
            params![relative_path],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((db_cache_key, status, font_json)) = row else {
        return Ok(false);
    };
    if db_cache_key != cache_key || (status != "ok" && status != "bad") { return Ok(false); }
    if status == "ok" {
        if let Some(version) = script_version {
            let font = font_json.and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
            if !font.as_ref().is_some_and(|value| value["scriptVersion"].as_u64() == Some(version) && value["scripts"].as_array().is_some_and(|scripts| !scripts.is_empty())) { return Ok(false); }
        }
    }
    Ok(true)
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
            if !file_entry_unchanged(&conn, &relative_path, &signature, input.script_detection_version).map_err(|error| error.to_string())? {
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
            // Parent mtime and counts cannot prove unchanged child content/names.
            checked_dirs += 1;
            return Ok(WatcherPreflightResult {
                unchanged: false,
                reason: "directory-enumeration-required".to_string(),
                checked_files,
                checked_dirs,
            });
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn directory_signals_require_enumeration_while_exact_file_signatures_can_skip() {
        let root = std::env::temp_dir().join(format!("hfm-watcher-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(root.join("nested")).unwrap();
        let file = root.join("nested/font.ttf"); fs::write(&file, b"font").unwrap();
        let db = root.join("index.sqlite"); let conn = Connection::open(&db).unwrap();
        conn.execute_batch("CREATE TABLE entries(relative_path TEXT,cache_key TEXT,status TEXT,is_deleted INTEGER,font_json TEXT)").unwrap();
        let metadata = fs::metadata(&file).unwrap();
        conn.execute("INSERT INTO entries VALUES(?1,?2,'ok',0,?3)", params!["nested/font.ttf", file_cache_signature("nested/font.ttf", metadata.len(), metadata_modified_ms(&metadata)), r#"{"scriptVersion":2,"scripts":["latin"]}"#]).unwrap();
        drop(conn);
        let input = root.join("input.json");
        let run = |name: &str| {
            fs::write(&input, serde_json::to_vec(&serde_json::json!({"rootPath":root.to_string_lossy(),"dbPath":db.to_string_lossy(),"extensions":["ttf"],"scriptDetectionVersion":2,"changes":[{"eventType":"change","fileName":name}]})).unwrap()).unwrap();
            run_watcher_preflight(&WatcherPreflightConfig { input_path: input.to_string_lossy().into_owned() }).unwrap()
        };
        assert!(run("nested/font.ttf").unchanged);
        let conn = Connection::open(&db).unwrap(); conn.execute("UPDATE entries SET font_json='{}'", []).unwrap(); drop(conn);
        assert!(!run("nested/font.ttf").unchanged, "incomplete font metadata must be repaired");
        let conn = Connection::open(&db).unwrap(); conn.execute("UPDATE entries SET font_json=?1", [r#"{"scriptVersion":2,"scripts":["latin"]}"#]).unwrap(); drop(conn);
        let directory = run("nested"); assert!(!directory.unchanged); assert_eq!(directory.reason,"directory-enumeration-required"); assert_eq!(directory.checked_dirs,1);
        fs::write(&file,b"changed font").unwrap(); assert!(!run("nested/font.ttf").unchanged); assert!(!run("nested").unchanged);
        fs::remove_dir_all(root).unwrap();
    }
}
