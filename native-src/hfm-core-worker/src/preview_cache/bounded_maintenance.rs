use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};
use rusqlite::{params, Connection, OptionalExtension};
use super::maintenance::is_iso_older_than;
use super::path::normalize_path_for_cache_compare;
use super::schema::{initialize_preview_cache_db, open_preview_cache_query};
use super::types::{PreviewCacheMaintenancePayload, PreviewCacheMaintenanceResult, PreviewCacheTimings};

// Each invocation releases the scheduler/physical I/O lease before the next batch.
// Never inspect a DB-discovered output path unless the caller declared that exact file.
pub(super) fn run(payload: &PreviewCacheMaintenancePayload) -> Result<String, String> {
    let started = Instant::now();
    let batch = payload.batch.as_ref().ok_or("missing maintenance batch")?;
    if !payload.preview_dirs.is_empty() || batch.rows.len() + batch.orphan_files.len() > 64 {
        return Err("bounded maintenance requires at most 64 files and no tree traversal".into());
    }
    let mut conn = Connection::open(&payload.db_path).map_err(|e| e.to_string())?;
    initialize_preview_cache_db(&conn, payload.schema_version).map_err(|e| e.to_string())?;
    let mut result = PreviewCacheMaintenanceResult { ok: true, checked_rows: 0, stale_rows: 0,
        removed_files: 0, removed_orphan_files: 0, errors: Vec::new(),
        timings: PreviewCacheTimings { elapsed: 0, rows: 0 }, worker_mode: "rust-preview-cache-maintenance".into() };
    if !batch.rows.is_empty() {
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for declared in &batch.rows {
            let row = tx.query_row("SELECT output_path, accessed_at, generated_at, updated_at FROM preview_cache WHERE preview_key = ? AND status = 'ok'",
                [&declared.preview_key], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?)))
                .optional().map_err(|e| e.to_string())?;
            let Some((output, accessed, generated, updated)) = row else { continue; };
            if output != declared.output_path { continue; }
            result.checked_rows += 1;
            let missing = if output.is_empty() { true } else {
                match fs::symlink_metadata(&output) {
                    Ok(stat) if stat.file_type().is_symlink() => { result.errors.push(format!("预览文件为符号链接，保留：{}", output)); continue; },
                    Ok(stat) => !stat.is_file(),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => true,
                    Err(e) => { result.errors.push(format!("预览状态读取失败，保留：{} {}", output, e)); continue; }
                }
            };
            let expired = !missing && is_iso_older_than(accessed.as_ref().or(generated.as_ref()).or(updated.as_ref()), payload.preview_ok_retention_ms);
            if expired {
                match fs::remove_file(&output) {
                    Ok(()) => result.removed_files += 1,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
                    Err(e) => { result.errors.push(format!("删除过期预览失败，保留索引：{} {}", output, e)); continue; }
                }
            }
            if missing || expired {
                let reason = if missing { "预览文件不存在，已标记为需要重建。" } else { "预览缓存长期未访问，已标记为需要重建。" };
                result.stale_rows += tx.execute("UPDATE preview_cache SET status = 'stale', message = ?, updated_at = ? WHERE preview_key = ?",
                    params![reason, payload.now, declared.preview_key]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    if !batch.orphan_files.is_empty() {
        // The shared/fallback store has its own index. Local absence alone must
        // never authorize deleting a PNG still referenced by that store.
        let mut referenced = references(&conn)?;
        if let Some(path) = &batch.reference_db_path {
            if normalize_path_for_cache_compare(path) != normalize_path_for_cache_compare(&payload.db_path) {
                let reference = open_preview_cache_query(path, payload.schema_version, true)?;
                referenced.extend(references(&reference)?);
            }
        }
        let threshold = Duration::from_millis(payload.orphan_retention_ms.max(0) as u64);
        for output in &batch.orphan_files {
            if referenced.contains(&normalize_path_for_cache_compare(output)) ||
                !Path::new(output).extension().map(|v| v.to_string_lossy().eq_ignore_ascii_case("png")).unwrap_or(false) { continue; }
            let stat = match fs::symlink_metadata(output) {
                Ok(stat) if stat.is_file() && !stat.file_type().is_symlink() => stat,
                Ok(_) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => { result.errors.push(format!("读取孤立预览失败：{} {}", output, e)); continue; }
            };
            let Ok(modified) = stat.modified() else { continue; };
            if SystemTime::now().duration_since(modified).unwrap_or_default() < threshold { continue; }
            match fs::remove_file(output) {
                Ok(()) => result.removed_orphan_files += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {},
                Err(e) => result.errors.push(format!("清理孤立预览失败：{} {}", output, e)),
            }
        }
    }
    result.timings = PreviewCacheTimings { elapsed: started.elapsed().as_millis(), rows: result.checked_rows };
    serde_json::to_string(&result).map_err(|e| e.to_string())
}

fn references(conn: &Connection) -> Result<HashSet<String>, String> {
    let mut statement = conn.prepare("SELECT output_path FROM preview_cache WHERE output_path != ''").map_err(|e| e.to_string())?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
    let mut paths = HashSet::new();
    for path in rows { paths.insert(normalize_path_for_cache_compare(&path.map_err(|e| e.to_string())?)); }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hfm-bounded-{}-{}-{}", std::process::id(), SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1,Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap(); Self(path)
        }
        fn db(&self, name: &str) -> Connection {
            let conn = Connection::open(self.0.join(name)).unwrap(); initialize_preview_cache_db(&conn,1).unwrap(); conn
        }
        fn input(&self, batch: Value) -> PreviewCacheMaintenancePayload {
            serde_json::from_value(json!({"dbPath":self.0.join("local.sqlite"),"schemaVersion":1,"now":"2026-09-28T00:00:00.000Z","previewDirs":[],"previewOkRetentionMs":1,"orphanRetentionMs":0,"batch":batch})).unwrap()
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    fn seed(conn: &Connection, key: &str, output: &str) {
        conn.execute("INSERT INTO preview_cache(preview_key,relative_path,output_path,font_signature,text_hash,font_size,width,height,storage,status,accessed_at,updated_at) VALUES (?,'',?,'','',12,1,1,'local','ok','2000-01-01T00:00:00.000Z','2000-01-01T00:00:00.000Z')",params![key,output]).unwrap();
    }
    #[test]
    fn only_declared_unchanged_rows_are_touched_and_io_errors_preserve_status() {
        let f=Fixture::new();let conn=f.db("local.sqlite");
        let (expired,changed)=(f.0.join("expired.png"),f.0.join("changed.png"));
        fs::write(&expired,b"old").unwrap();fs::write(&changed,b"keep").unwrap();
        seed(&conn,"expired",expired.to_str().unwrap());seed(&conn,"changed",changed.to_str().unwrap());
        seed(&conn,"missing",f.0.join("missing.png").to_str().unwrap());seed(&conn,"error","invalid\0path.png");
        let input=f.input(json!({"rows":[{"previewKey":"expired","outputPath":expired},{"previewKey":"changed","outputPath":"previous.png"},{"previewKey":"missing","outputPath":f.0.join("missing.png")},{"previewKey":"error","outputPath":"invalid\0path.png"}],"orphanFiles":[]}));
        let result:Value=serde_json::from_str(&run(&input).unwrap()).unwrap();
        assert_eq!(result["checkedRows"],3);assert_eq!(result["staleRows"],2);assert_eq!(result["removedFiles"],1);
        assert_eq!(result["errors"].as_array().unwrap().len(),1);assert!(changed.exists());assert!(!expired.exists());
        for key in ["changed","error"] { assert_eq!(conn.query_row("SELECT status FROM preview_cache WHERE preview_key=?",[key],|r|r.get::<_,String>(0)).unwrap(),"ok"); }
    }
    #[test]
    fn orphan_cleanup_rechecks_both_indexes_and_does_not_create_missing_reference_db() {
        let f=Fixture::new();let local=f.db("local.sqlite");let shared=f.db("shared.sqlite");
        let (kept,orphan,pending)=(f.0.join("kept.png"),f.0.join("orphan.png"),f.0.join("pending.png"));
        for p in [&kept,&orphan,&pending] { fs::write(p,b"png").unwrap(); }
        seed(&shared,"remote",kept.to_str().unwrap());seed(&local,"pending",pending.to_str().unwrap());
        local.execute("UPDATE preview_cache SET status='generating'",[]).unwrap();drop(shared);
        let input=f.input(json!({"rows":[],"orphanFiles":[kept,orphan,pending],"referenceDbPath":f.0.join("shared.sqlite")}));
        let result:Value=serde_json::from_str(&run(&input).unwrap()).unwrap();
        assert_eq!(result["removedOrphanFiles"],1);assert!(kept.exists());assert!(pending.exists());assert!(!orphan.exists());
        let invalid=f.input(json!({"rows":[],"orphanFiles":[kept],"referenceDbPath":f.0.join("missing.sqlite")}));
        assert!(run(&invalid).is_err());assert!(kept.exists());assert!(!f.0.join("missing.sqlite").exists());
    }
    #[test]
    fn oversized_and_recursive_batches_fail_before_opening_database() {
        let f=Fixture::new();let mut input=f.input(json!({"rows":[],"orphanFiles":vec!["a.png";65]}));
        assert!(run(&input).is_err());assert!(!f.0.join("local.sqlite").exists());
        input=f.input(json!({"rows":[],"orphanFiles":[]}));input.preview_dirs.push("root".into());
        assert!(run(&input).is_err());assert!(!f.0.join("local.sqlite").exists());
    }
}
