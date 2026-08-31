use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::{params, Connection};
use serde_json;

use super::path::normalize_path_for_cache_compare;
use super::schema::initialize_preview_cache_db;
use super::types::{PreviewCacheCommandConfig, PreviewCacheMaintenancePayload, PreviewCacheMaintenanceResult, PreviewCacheTimings};

pub fn run_preview_cache_maintenance(config: &PreviewCacheCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: PreviewCacheMaintenancePayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if let Some(parent) = Path::new(&payload.db_path).parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let mut errors = Vec::new();
    let mut conn = Connection::open(&payload.db_path).map_err(|error| error.to_string())?;
    initialize_preview_cache_db(&conn, payload.schema_version).map_err(|error| error.to_string())?;
    let tx = conn.transaction().map_err(|error| error.to_string())?;
    let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>)> = {
        let mut stmt = tx.prepare("SELECT preview_key, output_path, accessed_at, generated_at, updated_at FROM preview_cache WHERE status = 'ok'").map_err(|error| error.to_string())?;
        let mapped = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        }).map_err(|error| error.to_string())?;
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|error| error.to_string())?);
        }
        out
    };

    let mut referenced = HashSet::new();
    let mut stale_rows = 0usize;
    let mut removed_files = 0usize;
    let now = payload.now.clone();
    {
        let mut mark_stale = tx.prepare("UPDATE preview_cache SET status = 'stale', message = ?, updated_at = ? WHERE preview_key = ?").map_err(|error| error.to_string())?;
        for (preview_key, output_path, accessed_at, generated_at, updated_at) in &rows {
            if !output_path.trim().is_empty() {
                referenced.insert(normalize_path_for_cache_compare(output_path));
            }
            let exists = fs::metadata(output_path).map(|stat| stat.is_file()).unwrap_or(false);
            let mut should_stale = false;
            let mut reason = String::new();
            if output_path.trim().is_empty() || !exists {
                should_stale = true;
                reason = "预览文件不存在，已标记为需要重建。".to_string();
            } else if is_iso_older_than(accessed_at.as_ref().or(generated_at.as_ref()).or(updated_at.as_ref()), payload.preview_ok_retention_ms) {
                should_stale = true;
                reason = "预览缓存长期未访问，已标记为需要重建。".to_string();
                match fs::remove_file(output_path) {
                    Ok(_) => removed_files += 1,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                    Err(error) => errors.push(format!("删除过期预览失败：{} {}", output_path, error)),
                }
            }
            if should_stale {
                match mark_stale.execute(params![reason, &now, preview_key]) {
                    Ok(_) => stale_rows += 1,
                    Err(error) => errors.push(format!("标记预览缓存 stale 失败：{} {}", preview_key, error)),
                }
            }
        }
    }
    tx.commit().map_err(|error| error.to_string())?;

    let mut removed_orphan_files = 0usize;
    let orphan_threshold = Duration::from_millis(payload.orphan_retention_ms.max(0) as u64);
    for dir in &payload.preview_dirs {
        walk_preview_png_files(Path::new(dir), &mut |file_path| {
            let normalized = normalize_path_for_cache_compare(&file_path.to_string_lossy());
            if referenced.contains(&normalized) {
                return;
            }
            let stat = match fs::metadata(file_path) {
                Ok(value) => value,
                Err(error) => {
                    errors.push(format!("读取孤立预览失败：{} {}", file_path.display(), error));
                    return;
                }
            };
            let modified = stat.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            if SystemTime::now().duration_since(modified).unwrap_or_else(|_| Duration::from_secs(0)) < orphan_threshold {
                return;
            }
            match fs::remove_file(file_path) {
                Ok(_) => removed_orphan_files += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => errors.push(format!("清理孤立预览失败：{} {}", file_path.display(), error)),
            }
        });
    }

    let result = PreviewCacheMaintenanceResult {
        ok: true,
        checked_rows: rows.len(),
        stale_rows,
        removed_files,
        removed_orphan_files,
        errors,
        timings: PreviewCacheTimings { elapsed: started_at.elapsed().as_millis(), rows: rows.len() },
        worker_mode: "rust-preview-cache-maintenance".to_string(),
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn is_iso_older_than(value: Option<&String>, retention_ms: i64) -> bool {
    if retention_ms <= 0 {
        return false;
    }
    let Some(raw) = value else { return false; };
    let Some(epoch_ms) = parse_iso_epoch_ms(raw) else { return false; };
    let now_ms = match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i128,
        Err(_) => return false,
    };
    now_ms - epoch_ms as i128 > retention_ms as i128
}

fn parse_iso_epoch_ms(value: &str) -> Option<i64> {
    // Fast, dependency-free parser for timestamps produced by JS Date#toISOString: YYYY-MM-DDTHH:mm:ss.sssZ.
    if value.len() < 20 {
        return None;
    }
    let year = value.get(0..4)?.parse::<i32>().ok()?;
    let month = value.get(5..7)?.parse::<u32>().ok()?;
    let day = value.get(8..10)?.parse::<u32>().ok()?;
    let hour = value.get(11..13)?.parse::<u32>().ok()?;
    let minute = value.get(14..16)?.parse::<u32>().ok()?;
    let second = value.get(17..19)?.parse::<u32>().ok()?;
    let millis = if value.get(19..20) == Some(".") {
        value.get(20..23).unwrap_or("0").parse::<u32>().unwrap_or(0)
    } else {
        0
    };
    let days = days_from_civil(year, month, day)?;
    Some((((days * 24 + hour as i64) * 60 + minute as i64) * 60 + second as i64) * 1000 + millis as i64)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let y = year as i64 - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = month as i64 + if month > 2 { -3 } else { 9 };
    let doy = (153 * mp + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146097 + doe - 719468)
}

fn walk_preview_png_files<F: FnMut(&PathBuf)>(dir: &Path, callback: &mut F) {
    let Ok(entries) = fs::read_dir(dir) else { return; };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(file_type) = entry.file_type() else { continue; };
        if file_type.is_dir() {
            walk_preview_png_files(&path, callback);
        } else if file_type.is_file() && path.extension().map(|ext| ext.to_string_lossy().eq_ignore_ascii_case("png")).unwrap_or(false) {
            callback(&path);
        }
    }
}
