use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::Connection;
use serde_json::Value;

use super::signature::shared_metadata_signature_for_conn;
use super::types::{
    SharedMetadataCommandConfig,
    SharedMetadataKnownTagsPayload,
    SharedMetadataKnownTagsResult,
    SharedMetadataKnownTagsRootResult,
    SharedMetadataOverlayMatchedEntry,
    SharedMetadataOverlayReadPayload,
    SharedMetadataOverlayReadResult,
    SharedMetadataTimings,
};

#[derive(Clone, Debug)]
struct OverlayState {
    tag_names: Vec<String>,
    favorite: bool,
    delete_protected: bool,
}

#[derive(Clone, Debug, Default)]
struct OverlayMaps {
    by_font_id: BTreeMap<String, OverlayState>,
    by_relative_path: BTreeMap<String, OverlayState>,
    by_path_key: BTreeMap<String, OverlayState>,
    rows: usize,
}

pub fn read_shared_metadata_known_tags(config: &SharedMetadataCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: SharedMetadataKnownTagsPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let result = read_known_tags(&payload, started_at)?;
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn read_shared_metadata_overlay(config: &SharedMetadataCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: SharedMetadataOverlayReadPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let result = read_overlay_matches(&payload, started_at)?;
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn read_known_tags(payload: &SharedMetadataKnownTagsPayload, started_at: Instant) -> Result<SharedMetadataKnownTagsResult, String> {
    let mut known_tags = BTreeSet::<String>::new();
    let mut roots = Vec::<SharedMetadataKnownTagsRootResult>::new();
    let mut total_rows = 0usize;

    for root in &payload.roots {
        let db_path = root.db_path.trim();
        let root_path = root.root_path.trim();
        let missing = if db_path.is_empty() { true } else { match fs::metadata(db_path) {
            Ok(_) => false,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => { fs::metadata(root_path).map_err(|error|error.to_string())?; true },
            Err(error) => return Err(error.to_string()),
        }};
        if missing {
            roots.push(SharedMetadataKnownTagsRootResult {
                root_path: root_path.to_string(),
                db_path: db_path.to_string(),
                signature: "metadata:none".to_string(),
                known_tags: Vec::new(),
                rows: 0,
            });
            continue;
        }

        let conn = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|error| error.to_string())?;

        let (root_tags, rows) = read_root_known_tags(&conn).map_err(|error| error.to_string())?;
        let signature = shared_metadata_signature_for_conn(&conn).map_err(|error|error.to_string())?;
        total_rows += rows;
        for tag in &root_tags {
            known_tags.insert(tag.clone());
        }
        roots.push(SharedMetadataKnownTagsRootResult {
            root_path: root_path.to_string(),
            db_path: db_path.to_string(),
            signature,
            known_tags: root_tags,
            rows,
        });
    }

    Ok(SharedMetadataKnownTagsResult {
        ok: true,
        known_tags: known_tags.into_iter().collect(),
        roots,
        timings: SharedMetadataTimings { elapsed: started_at.elapsed().as_millis(), rows: total_rows },
        worker_mode: "rust-shared-metadata-known-tags".to_string(),
    })
}

fn read_overlay_matches(payload: &SharedMetadataOverlayReadPayload, started_at: Instant) -> Result<SharedMetadataOverlayReadResult, String> {
    let db_path = payload.db_path.trim();
    let root_path = payload.root_path.trim();
    if db_path.is_empty() { return Err("empty shared metadata path".into()); }
    if payload.binding_snapshot { return read_binding_snapshot(payload, started_at); }
    let missing = match fs::metadata(db_path) { Ok(_) => false, Err(error) if error.kind() == std::io::ErrorKind::NotFound => true, Err(error) => return Err(error.to_string()) };
    if missing && (payload.preflight.is_none() || payload.preflight.as_ref().is_some_and(|value| value["phase"] == "maintenance-snapshot")) {
        return Ok(SharedMetadataOverlayReadResult {
            binding_snapshot: None,
            preflight: payload.preflight.as_ref().map(|_| serde_json::json!({"version":1,"phase":"maintenance-snapshot","maintenance":{"exists":false,"token":"missing","tables":{}}})),
            ok: true,
            root_path: root_path.to_string(),
            db_path: db_path.to_string(),
            signature: "metadata:none".to_string(),
            matched: Vec::new(),
            rows: 0,
            requested: payload.entries.len(),
            timings: SharedMetadataTimings { elapsed: started_at.elapsed().as_millis(), rows: 0 },
            worker_mode: "rust-shared-metadata-overlay-read".to_string(),
        });
    }

    if payload.preflight.is_some() {
        if let Some(parent) = Path::new(db_path).parent() { fs::create_dir_all(parent).map_err(|error| error.to_string())?; }
    }
    let mut conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    let preflight = payload.preflight.as_ref().map(|value| super::preflight::run(&mut conn, value)).transpose()?;
    let overlay = read_overlay_maps(&conn).map_err(|error| error.to_string())?;
    let signature = shared_metadata_signature_for_conn(&conn).map_err(|error|error.to_string())?;
    let mut matched = Vec::<SharedMetadataOverlayMatchedEntry>::new();

    for entry in &payload.entries {
        let key = entry.key.trim();
        if key.is_empty() {
            continue;
        }
        let relative_path = normalize_relative_path(&entry.relative_path);
        let font_id = entry.font_id.trim();
        let path_key = normalize_path_key(&entry.path_key);
        let found = overlay
            .by_relative_path
            .get(&relative_path)
            .map(|state| (state, "relativePath"))
            .or_else(|| overlay.by_font_id.get(font_id).map(|state| (state, "fontId")))
            .or_else(|| overlay.by_path_key.get(&path_key).map(|state| (state, "pathKey")));
        let Some((state, matched_by)) = found else {
            continue;
        };
        matched.push(SharedMetadataOverlayMatchedEntry {
            key: key.to_string(),
            tag_names: state.tag_names.clone(),
            favorite: state.favorite,
            delete_protected: state.delete_protected,
            matched_by: matched_by.to_string(),
        });
    }

    Ok(SharedMetadataOverlayReadResult {
        binding_snapshot: None,
        preflight,
        ok: true,
        root_path: root_path.to_string(),
        db_path: db_path.to_string(),
        signature,
        matched,
        rows: overlay.rows,
        requested: payload.entries.len(),
        timings: SharedMetadataTimings { elapsed: started_at.elapsed().as_millis(), rows: overlay.rows },
        worker_mode: "rust-shared-metadata-overlay-read".to_string(),
    })
}

fn read_binding_snapshot(payload: &SharedMetadataOverlayReadPayload, started_at: Instant) -> Result<SharedMetadataOverlayReadResult, String> {
    if payload.preflight.is_some() || !payload.entries.is_empty() { return Err("binding snapshot cannot carry mutation preflight or overlay entries".into()); }
    let db_path = payload.db_path.trim();
    let root_path = payload.root_path.trim();
    let missing = match fs::metadata(db_path) {
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !fs::metadata(root_path).map_err(|error| error.to_string())?.is_dir() { return Err("binding root is not a directory".into()); }
            true
        },
        Err(error) => return Err(error.to_string()),
    };
    let (rows, signature) = if missing {
        (Vec::<Value>::new(), "metadata:none".to_string())
    } else {
        let mut conn = super::binding_snapshot::open(db_path)?;
        conn.execute_batch("PRAGMA temp_store=MEMORY;").map_err(|error| error.to_string())?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Deferred).map_err(|error| error.to_string())?;
        // Incompatible existing schema is unknown, never authoritative emptiness.
        let mut statement = tx.prepare("SELECT font_id,relative_path,path_key,tag_names_json,favorite,delete_protected,revision FROM font_metadata ORDER BY font_id").map_err(|error| error.to_string())?;
        let mapped = statement.query_map([], |row| Ok(serde_json::json!({
            "font_id":row.get::<_, Option<String>>(0)?, "relative_path":row.get::<_, Option<String>>(1)?,
            "path_key":row.get::<_, Option<String>>(2)?, "tag_names_json":row.get::<_, Option<String>>(3)?,
            "favorite":row.get::<_, Option<i64>>(4)?, "delete_protected":row.get::<_, Option<i64>>(5)?, "revision":row.get::<_, Option<i64>>(6)?
        }))).map_err(|error| error.to_string())?;
        let rows = mapped.collect::<rusqlite::Result<Vec<Value>>>().map_err(|error| error.to_string())?;
        drop(statement);
        let signature = shared_metadata_signature_for_conn(&tx).map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        (rows, signature)
    };
    let count = rows.len();
    Ok(SharedMetadataOverlayReadResult {
        binding_snapshot: Some(serde_json::json!({"version":1,"rows":rows})), preflight: None,
        ok: true, root_path: root_path.to_string(), db_path: db_path.to_string(), signature,
        matched: Vec::new(), rows: count, requested: 0,
        timings: SharedMetadataTimings { elapsed: started_at.elapsed().as_millis(), rows: count },
        worker_mode: "rust-shared-metadata-overlay-read".to_string(),
    })
}

fn read_root_known_tags(conn: &Connection) -> rusqlite::Result<(Vec<String>, usize)> {
    if !table_exists(conn, "font_metadata")? {
        return Ok((Vec::new(), 0));
    }
    let mut stmt = conn.prepare("SELECT tag_names_json FROM font_metadata")?;
    let rows = stmt.query_map([], |row| row.get::<_, Option<String>>(0))?;
    let mut tags = BTreeSet::<String>::new();
    let mut count = 0usize;
    for row in rows {
        count += 1;
        let tag_json = row?.unwrap_or_default();
        for tag in parse_tag_names_json(&tag_json) {
            tags.insert(tag);
        }
    }
    Ok((tags.into_iter().collect(), count))
}

fn read_overlay_maps(conn: &Connection) -> rusqlite::Result<OverlayMaps> {
    if !table_exists(conn, "font_metadata")? {
        return Ok(OverlayMaps::default());
    }
    let mut stmt = conn.prepare("SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected FROM font_metadata")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<i64>>(5)?,
        ))
    })?;
    let mut overlay = OverlayMaps::default();
    for row in rows {
        overlay.rows += 1;
        let row = row?;
        let state = OverlayState {
            tag_names: parse_tag_names_json(&row.3.unwrap_or_default()),
            favorite: row.4.unwrap_or(0) != 0,
            delete_protected: row.5.unwrap_or(0) != 0,
        };
        if let Some(font_id) = row.0.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
            overlay.by_font_id.insert(font_id, state.clone());
        }
        if let Some(relative_path) = row.1.map(|value| normalize_relative_path(&value)).filter(|value| !value.is_empty()) {
            overlay.by_relative_path.insert(relative_path, state.clone());
        }
        if let Some(path_key) = row.2.map(|value| normalize_path_key(&value)).filter(|value| !value.is_empty()) {
            overlay.by_path_key.insert(path_key, state);
        }
    }
    Ok(overlay)
}

fn parse_tag_names_json(value: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<Value>(value) else {
        return Vec::new();
    };
    let Some(items) = parsed.as_array() else {
        return Vec::new();
    };
    let mut tags = BTreeSet::<String>::new();
    for item in items {
        let Some(text) = item.as_str() else {
            continue;
        };
        let tag = text.trim();
        if !tag.is_empty() {
            tags.insert(tag.to_string());
        }
    }
    tags.into_iter().collect()
}

fn normalize_relative_path(value: &str) -> String {
    value.replace('\\', "/")
}

fn normalize_path_key(value: &str) -> String {
    value.replace('\\', "/").to_lowercase()
}

fn table_exists(conn: &Connection, table_name: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        [table_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}


#[cfg(all(test, windows))]
mod binding_snapshot_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(std::path::PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("hfm-binding-read-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
            fs::create_dir_all(&path).unwrap(); Self(path)
        }
        fn payload(&self, file: &str) -> SharedMetadataOverlayReadPayload {
            serde_json::from_value(serde_json::json!({"rootPath": self.0, "dbPath": self.0.join(file), "entries":[], "bindingSnapshot":true})).unwrap()
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
    #[test]
    fn readonly_binding_snapshot_does_not_initialize_backfill_or_change_database() {
        let fixture = Fixture::new(); let file = fixture.0.join("metadata.sqlite");
        let conn = Connection::open(&file).unwrap();
        conn.execute_batch("CREATE TABLE font_metadata(font_id TEXT,relative_path TEXT,path_key TEXT,tag_names_json TEXT,favorite INTEGER,delete_protected INTEGER,revision INTEGER,updated_at TEXT); INSERT INTO font_metadata VALUES('one','one.ttf','one.ttf','[\"Shared\"]',1,0,7,'old');").unwrap();
        drop(conn);
        let before = fs::read(&file).unwrap(); let modified = fs::metadata(&file).unwrap().modified().unwrap();
        let result = read_overlay_matches(&fixture.payload("metadata.sqlite"), Instant::now()).unwrap();
        assert!(result.preflight.is_none());
        let snapshot = result.binding_snapshot.unwrap();
        assert_eq!(snapshot["version"], 1); assert_eq!(snapshot["rows"][0]["tag_names_json"], "[\"Shared\"]");
        assert_eq!(fs::read(&file).unwrap(), before); assert_eq!(fs::metadata(&file).unwrap().modified().unwrap(), modified);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 1);
        let conn = Connection::open_with_flags(&file, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert!(!table_exists(&conn, "shared_tag_ops").unwrap()); assert!(!table_exists(&conn, "meta").unwrap());
    }
    #[test]
    fn missing_database_is_empty_only_when_root_is_available_and_never_created() {
        let fixture = Fixture::new();
        let result = read_overlay_matches(&fixture.payload("absent/cache.sqlite"), Instant::now()).unwrap();
        assert_eq!(result.binding_snapshot.unwrap()["rows"].as_array().unwrap().len(), 0);
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
        let mut payload = fixture.payload("absent/cache.sqlite"); payload.root_path = fixture.0.join("offline").to_string_lossy().to_string();
        assert!(read_overlay_matches(&payload, Instant::now()).is_err());
        let conn = Connection::open(fixture.0.join("incompatible.sqlite")).unwrap(); conn.execute_batch("CREATE TABLE unrelated(id TEXT)").unwrap(); drop(conn);
        assert!(read_overlay_matches(&fixture.payload("incompatible.sqlite"), Instant::now()).is_err());
    }
    #[test]
    fn wal_binding_snapshot_reads_committed_rows_and_signature_without_sidecars() {
        let fixture = Fixture::new(); let path = fixture.0.join("wal.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE font_metadata(font_id TEXT,relative_path TEXT,path_key TEXT,tag_names_json TEXT,favorite INTEGER,delete_protected INTEGER,revision INTEGER,updated_at TEXT); PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO font_metadata VALUES('one','one.ttf','one.ttf','[\"Committed\"]',1,0,7,'wal');").unwrap();
        let database = fs::read(&path).unwrap(); let wal_path = fixture.0.join("wal.sqlite-wal"); let wal = fs::read(&wal_path).unwrap();
        assert!(read_overlay_matches(&fixture.payload("wal.sqlite"), Instant::now()).is_err(), "existing writable connection was admitted");
        drop(conn);
        fs::write(&path, database).unwrap(); fs::write(&wal_path, wal).unwrap();
        let files = || fs::read_dir(&fixture.0).unwrap().map(|entry| { let file = entry.unwrap().path(); (file.file_name().unwrap().to_os_string(), (fs::read(&file).unwrap(),fs::metadata(&file).unwrap().modified().unwrap())) }).collect::<BTreeMap<_,_>>();
        let before = files();
        let result = read_overlay_matches(&fixture.payload("wal.sqlite"), Instant::now()).unwrap();
        assert_eq!(result.binding_snapshot.unwrap()["rows"][0]["tag_names_json"], "[\"Committed\"]");
        assert_eq!(result.signature, "metadata-v2||1|7|wal|0|0");
        assert!(result.preflight.is_none()); assert_eq!(files(), before);
        assert!(!fixture.0.join("wal.sqlite-shm").exists());
    }
    #[test]
    fn readonly_binding_snapshot_rejects_mixed_mutation_request_without_writes() {
        let fixture = Fixture::new(); let mut payload = fixture.payload("absent.sqlite");
        payload.preflight = Some(serde_json::json!({"phase":"snapshot","updatedAt":"now","updatedBy":"fixture","writerPid":1}));
        assert!(read_overlay_matches(&payload, Instant::now()).is_err());
        assert_eq!(fs::read_dir(&fixture.0).unwrap().count(), 0);
    }
}
