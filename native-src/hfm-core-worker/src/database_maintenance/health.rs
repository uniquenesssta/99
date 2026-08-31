use std::fs;
use std::time::Instant;

use rusqlite::{Connection, OpenFlags};

use super::types::{DatabaseHealthCheckPayload, DatabaseHealthCheckResult, DatabaseHealthItemResult};

fn quick_check_message(file_path: &str, busy_timeout_ms: u64) -> Result<String, String> {
    fs::metadata(file_path).map_err(|error| format!("数据库文件不存在或无法访问：{}", error))?;
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(file_path, flags).map_err(|error| error.to_string())?;
    conn.busy_timeout(std::time::Duration::from_millis(busy_timeout_ms)).map_err(|error| error.to_string())?;
    let message: String = conn
        .query_row("PRAGMA quick_check;", [], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    Ok(if message.trim().is_empty() { "ok".to_string() } else { message })
}

pub fn run_database_health_check(input: DatabaseHealthCheckPayload) -> Result<String, String> {
    let started_at = Instant::now();
    let mut items = Vec::with_capacity(input.items.len());

    for item in input.items {
        let message_result = quick_check_message(&item.file_path, input.busy_timeout_ms);
        match message_result {
            Ok(message) => {
                let ok = message.eq_ignore_ascii_case("ok");
                items.push(DatabaseHealthItemResult {
                    label: item.label,
                    file_path: item.file_path,
                    ok,
                    message,
                });
            }
            Err(message) => {
                items.push(DatabaseHealthItemResult {
                    label: item.label,
                    file_path: item.file_path,
                    ok: false,
                    message,
                });
            }
        }
    }

    let result = DatabaseHealthCheckResult {
        ok: items.iter().all(|item| item.ok),
        items,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-database-health-check",
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}
