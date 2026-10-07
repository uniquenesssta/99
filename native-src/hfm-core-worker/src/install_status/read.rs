use std::collections::BTreeMap;
use std::fs;
use std::time::Instant;

use rusqlite::Connection;
use serde_json::Value;

use super::schema::ensure_install_status_columns;
use super::types::{
    InstallStatusCommandConfig, InstallStatusCompareResult, InstallStatusReadPayload,
    InstallStatusReadResult, InstallStatusTimings,
};

pub fn read_install_status_index(config: &InstallStatusCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: InstallStatusReadPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let mut results = BTreeMap::new();
    let mut missing_ids = Vec::new();
    let mut timings = InstallStatusTimings::default();

    for group in payload.groups {
        if group.items.is_empty() {
            continue;
        }
        timings.groups += 1;
        if !std::path::Path::new(&group.db_path).exists() {
            missing_ids.extend(group.items.into_iter().map(|item| item.id));
            continue;
        }
        let conn = Connection::open_with_flags(
            &group.db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|error| error.to_string())?;
        let _ = conn.execute_batch("PRAGMA query_only = ON");
        let _ = ensure_install_status_columns(&conn);
        let mut stmt = conn
            .prepare("SELECT signature, installed, by_type, matches_json FROM install_status WHERE font_id = ?")
            .map_err(|error| error.to_string())?;
        for item in group.items {
            timings.rows += 1;
            let row = stmt.query_row([item.id.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            });
            match row {
                Ok((signature, installed, by_type, matches_json)) if signature == item.signature => {
                    let matches = serde_json::from_str::<Value>(&matches_json)
                        .unwrap_or_else(|_| Value::Array(Vec::new()));
                    results.insert(
                        item.id,
                        InstallStatusCompareResult {
                            installed: installed != 0,
                            by: normalize_by_type(&by_type),
                            matches,
                        },
                    );
                }
                _ => missing_ids.push(item.id),
            }
        }
    }

    timings.elapsed = started_at.elapsed().as_millis();
    let result = InstallStatusReadResult {
        ok: true,
        results,
        missing_ids,
        timings,
        worker_mode: "rust-install-status-read".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn normalize_by_type(value: &str) -> String {
    match value {
        "managed" | "system" | "both" | "user" | "none" => value.to_string(),
        _ => "none".to_string(),
    }
}
