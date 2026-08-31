use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params, Connection};

use super::schema::{initialize_install_status_db, set_meta};
use super::types::{InstallStatusCommandConfig, InstallStatusSavePayload, InstallStatusSaveResult, InstallStatusTimings};

pub fn save_install_status_index(config: &InstallStatusCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: InstallStatusSavePayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let mut written = 0usize;
    let mut group_count = 0usize;
    let mut rows_seen = 0usize;
    let checked_at = sqlite_timestamp();

    for group in payload.groups {
        if group.rows.is_empty() {
            continue;
        }
        if let Some(parent) = Path::new(&group.db_path).parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut conn = Connection::open(&group.db_path).map_err(|error| error.to_string())?;
        let root_path = if group.root_path.trim().is_empty() {
            group.root_label.as_str()
        } else {
            group.root_path.as_str()
        };
        initialize_install_status_db(&conn, root_path).map_err(|error| error.to_string())?;
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO install_status (font_id, signature, installed, by_type, matches_json, checked_at, system_default)
                 VALUES (?, ?, ?, ?, ?, ?, ?)"
            ).map_err(|error| error.to_string())?;
            for row in group.rows {
                rows_seen += 1;
                let matches_json = serde_json::to_string(&row.matches)
                    .unwrap_or_else(|_| "[]".to_string());
                stmt.execute(params![
                    row.font_id,
                    row.signature,
                    if row.installed { 1 } else { 0 },
                    normalize_by_type(&row.by),
                    matches_json,
                    checked_at,
                    if row.system_default { 1 } else { 0 },
                ]).map_err(|error| error.to_string())?;
                written += 1;
            }
        }
        tx.commit().map_err(|error| error.to_string())?;
        set_meta(&conn, "updatedAt", &checked_at).map_err(|error| error.to_string())?;
        group_count += 1;
    }

    let result = InstallStatusSaveResult {
        ok: true,
        written,
        groups: group_count,
        timings: InstallStatusTimings {
            elapsed: started_at.elapsed().as_millis(),
            groups: group_count,
            rows: rows_seen,
        },
        worker_mode: "rust-install-status-save".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn normalize_by_type(value: &str) -> &str {
    match value {
        "managed" | "system" | "both" | "user" | "none" => value,
        _ => "none",
    }
}

fn sqlite_timestamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    let days = seconds.div_euclid(86_400);
    let secs_of_day = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z", year, month, day, hour, minute, second)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}
