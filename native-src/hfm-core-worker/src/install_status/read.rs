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
    let mut missing_reasons = BTreeMap::new();
    let mut read_error = false;
    let mut timings = InstallStatusTimings::default();

    for group in payload.groups {
        if group.items.is_empty() {
            continue;
        }
        timings.groups += 1;
        let exists = match fs::metadata(&group.db_path) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(format!("install-status-authority-unavailable: {}", error)),
        };
        if !exists {
            for item in group.items { missing_reasons.insert(item.id.clone(), "missing-db".to_string()); missing_ids.push(item.id); }
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
                Ok((signature, installed, by_type, matches_json)) if signature == item.signature && (installed == 0 || installed == 1) => {
                    let matches = serde_json::from_str::<Value>(&matches_json)
                        .unwrap_or_else(|_| Value::Array(Vec::new()));
                    results.insert(
                        item.id,
                        InstallStatusCompareResult {
                            known: true,
                            installed: installed != 0,
                            by: normalize_by_type(&by_type),
                            matches,
                        },
                    );
                }
                other => {
                    let reason = match other {
                        Ok((signature, _, _, _)) if signature.starts_with("unknown:") => "explicit-unknown",
                        Ok((signature, _, _, _)) if !signature.starts_with("content-v1:") => "legacy-evidence",
                        Ok((signature, _, _, _)) if signature != item.signature => "signature-mismatch",
                        Ok(_) => "invalid-row",
                        Err(rusqlite::Error::QueryReturnedNoRows) => "missing-row",
                        Err(_) => { read_error = true; "read-error" },
                    };
                    missing_reasons.insert(item.id.clone(), reason.to_string());
                    missing_ids.push(item.id);
                },
            }
        }
    }

    timings.elapsed = started_at.elapsed().as_millis();
    let result = InstallStatusReadResult {
        ok: true,
        results,
        missing_ids,
        missing_reasons,
        read_error,
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

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);

    #[test]
    fn install_authority_read_classifies_exact_unknown_missing_and_corrupt() {
        let dir = std::env::temp_dir().join(format!("hfm-install-authority-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("install.sqlite");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch("CREATE TABLE install_status(font_id TEXT PRIMARY KEY,signature TEXT,installed INTEGER,by_type TEXT,matches_json TEXT)").unwrap();
        for (id, signature) in [("known", "content-v1:exact"), ("stale", "content-v1:stale"), ("unknown", "unknown:content-v1:exact")] {
            conn.execute("INSERT INTO install_status VALUES (?,?,0,'none','[]')", params![id, signature]).unwrap();
        }
        drop(conn);
        let input_path = dir.join("input.json");
        fs::write(&input_path, json!({"groups":[{"dbPath":db_path,"items":[
            {"id":"known","signature":"content-v1:exact"}, {"id":"stale","signature":"content-v1:exact"},
            {"id":"unknown","signature":"content-v1:exact"}, {"id":"missing","signature":"content-v1:exact"}
        ]}]}).to_string()).unwrap();
        let config = InstallStatusCommandConfig { input_path: input_path.to_string_lossy().into_owned() };
        let output: Value = serde_json::from_str(&read_install_status_index(&config).unwrap()).unwrap();
        assert_eq!(output["results"].as_object().unwrap().len(), 1);
        assert_eq!(output["missingReasons"]["stale"], "signature-mismatch");
        assert_eq!(output["missingReasons"]["unknown"], "explicit-unknown");
        assert_eq!(output["missingReasons"]["missing"], "missing-row");
        assert_eq!(output["readError"], false);
        fs::remove_file(&db_path).unwrap();
        let absent: Value = serde_json::from_str(&read_install_status_index(&config).unwrap()).unwrap();
        assert_eq!(absent["missingReasons"]["known"], "missing-db");
        fs::write(&db_path, b"not a database").unwrap();
        assert!(read_install_status_index(&config).is_err(), "unreadable database was treated as absence");
        fs::remove_file(&db_path).unwrap();
        fs::create_dir(&db_path).unwrap();
        assert!(read_install_status_index(&config).is_err(), "directory authority was treated as absence");
        fs::remove_dir_all(&dir).unwrap();
    }
}
