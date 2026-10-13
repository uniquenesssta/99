//! Windows filesystem and SQLite regressions for destructive cache cleanup.
//! These tests require Windows sharing semantics and must be run on Windows.

use super::*;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

const KEY_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const KEY_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const KEY_C: &str = "cccccccccccccccccccccccccccccccccccccccc";

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "hfm-cleanup-{}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf { self.0.join(name) }

    fn request(&self, operation: &str, name: &str, extra: Value) -> Request {
        let mut value = json!({"operation": operation, "path": self.path(name), "rootPath": self.0});
        for (key, value_extra) in extra.as_object().unwrap() {
            value[key] = value_extra.clone();
        }
        serde_json::from_value(value).unwrap()
    }

    fn guard(&self, name: &str, bytes: &[u8]) -> Value {
        let path = self.path(name);
        fs::write(&path, bytes).unwrap();
        json!({"path": path, "identity": crate::font_resource::activation_identity::inspect(&path).unwrap()})
    }

    fn preview_request(&self, operation: &str, keys: &[&str]) -> Request {
        self.request(operation, "preview.sqlite", json!({
            "dest": self.path("images"), "rootPath": self.path("images"),
            "previewKeys": keys, "schemaVersion": 1,
        }))
    }

    fn preview_db(&self) -> Connection {
        fs::create_dir(self.path("images")).unwrap();
        let db = Connection::open(self.path("preview.sqlite")).unwrap();
        crate::preview_cache::initialize_preview_cache_db(&db, 1).unwrap();
        db
    }

    fn png(&self, key: &str) -> PathBuf { self.path("images").join(format!("{key}.png")) }

    fn publish_lock(&self, key: &str) -> PathBuf {
        self.path("images").join(format!("{key}.png.publish.lock"))
    }

    fn preview_row(&self, db: &Connection, key: &str, output: &Path) {
        db.execute(
            "INSERT INTO preview_cache (preview_key,relative_path,output_path,font_signature,text_hash,font_size,width,height,storage,status,updated_at)
             VALUES (?1,'font.ttf',?2,'signature','text',12,100,30,'root','ok','fixture-time')",
            rusqlite::params![key, output.to_string_lossy().as_ref()],
        ).unwrap();
    }

    fn row_exists(&self, key: &str) -> bool {
        let db = Connection::open_with_flags(self.path("preview.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        db.query_row("SELECT EXISTS(SELECT 1 FROM preview_cache WHERE preview_key = ?)", [key], |row| row.get(0)).unwrap()
    }
}

impl Drop for Directory {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn outcome<'a>(result: &'a Value, key: &str) -> &'a Value {
    result.as_array().unwrap().iter().find(|row| row["key"] == key).unwrap()
}

fn assert_preview_rejected(result: io::Result<Value>, key: &str) {
    if let Ok(result) = result {
        let row = outcome(&result, key);
        assert_eq!(row["status"], "failed");
        assert_eq!(row["rowsCommitted"], false);
    }
}

fn create_junction(link: &Path, target: &Path) {
    // Directory junctions do not require Developer Mode or symlink privileges.
    let output = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(output.status.success(), "junction creation failed: {} {}",
        String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    use std::os::windows::fs::MetadataExt;
    assert_ne!(fs::symlink_metadata(link).unwrap().file_attributes() & 0x400, 0);
}

#[test]
fn cleanup_held_writer_rejects_every_target_without_changing_guard_bytes() {
    let dir = Directory::new();
    let guard = dir.guard("writer.lock", b"original writer lease");
    for name in ["index.sqlite", "index.sqlite-wal", "index.json"] {
        fs::write(dir.path(name), name.as_bytes()).unwrap();
    }
    let writer = fs::OpenOptions::new().read(true).write(true).share_mode(0).open(dir.path("writer.lock")).unwrap();
    let request = dir.request("removeWithOwnedLocks", "writer.lock", json!({
        "guards": [guard],
        "paths": [dir.path("index.sqlite"), dir.path("index.sqlite-wal"), dir.path("index.json")],
    }));
    assert!(cleanup::remove_with_owned_locks(&request, || panic!("busy lease must reject before deletion")).is_err());
    for name in ["index.sqlite", "index.sqlite-wal", "index.json"] {
        assert_eq!(fs::read(dir.path(name)).unwrap(), name.as_bytes());
    }
    drop(writer);
    assert_eq!(fs::read(dir.path("writer.lock")).unwrap(), b"original writer lease");
}

#[test]
fn cleanup_changed_later_guard_rejects_all_targets_and_preserves_both_owners() {
    let dir = Directory::new();
    let first = dir.guard("first.lock", b"first owner");
    let second = dir.guard("second.lock", b"second owner");
    fs::write(dir.path("index.sqlite"), b"retained database").unwrap();
    fs::rename(dir.path("second.lock"), dir.path("previous.lock")).unwrap();
    // Equal bytes ensure this regression checks object identity, not only hash.
    fs::write(dir.path("second.lock"), b"second owner").unwrap();
    let request = dir.request("removeWithOwnedLocks", "first.lock", json!({
        "guards": [first, second], "paths": [dir.path("index.sqlite")],
    }));
    assert!(cleanup::remove_with_owned_locks(&request, || panic!("all guards must be validated first")).is_err());
    assert_eq!(fs::read(dir.path("index.sqlite")).unwrap(), b"retained database");
    assert_eq!(fs::read(dir.path("first.lock")).unwrap(), b"first owner");
    assert_eq!(fs::read(dir.path("second.lock")).unwrap(), b"second owner");
}

#[test]
fn cleanup_pins_every_guard_against_replacement_after_validation() {
    let dir = Directory::new();
    let guards = [dir.guard("first.lock", b"first"), dir.guard("second.lock", b"second")];
    fs::write(dir.path("index.sqlite"), b"cache").unwrap();
    let request = dir.request("removeWithOwnedLocks", "first.lock", json!({
        "guards": guards, "paths": [dir.path("index.sqlite")],
    }));
    let result = cleanup::remove_with_owned_locks(&request, || {
        for name in ["first.lock", "second.lock"] {
            assert!(fs::rename(dir.path(name), dir.path(&format!("{name}.replaced"))).is_err());
            assert!(fs::remove_file(dir.path(name)).is_err());
            assert!(fs::OpenOptions::new().write(true).truncate(true).open(dir.path(name)).is_err());
        }
    }).unwrap();
    assert_eq!(result[0]["status"], "removed");
    assert!(!dir.path("index.sqlite").exists());
    assert_eq!(fs::read(dir.path("first.lock")).unwrap(), b"first");
    assert_eq!(fs::read(dir.path("second.lock")).unwrap(), b"second");
    // Every pin must also be released after the batch.
    fs::rename(dir.path("first.lock"), dir.path("released.lock")).unwrap();
}

#[test]
fn cleanup_reports_missing_and_partial_unlink_failure_without_stopping_later_targets() {
    let dir = Directory::new();
    let guard = dir.guard("cleanup.lock", b"owned");
    for name in ["before.sqlite", "blocked.sqlite", "after.json"] { fs::write(dir.path(name), b"cache").unwrap(); }
    let blocked = fs::OpenOptions::new().read(true).share_mode(0).open(dir.path("blocked.sqlite")).unwrap();
    let targets = [dir.path("before.sqlite"), dir.path("blocked.sqlite"), dir.path("missing.sqlite"), dir.path("after.json")];
    let request = dir.request("removeWithOwnedLocks", "cleanup.lock", json!({"guards": [guard], "paths": targets}));
    let result = cleanup::remove_with_owned_locks(&request, || {}).unwrap();
    assert_eq!(result.as_array().unwrap().len(), targets.len());
    for (index, status) in ["removed", "failed", "missing", "removed"].iter().enumerate() {
        assert_eq!(result[index]["path"], json!(targets[index]));
        assert_eq!(result[index]["status"], *status);
    }
    assert!(!result[1]["message"].as_str().unwrap().is_empty());
    assert!(!dir.path("before.sqlite").exists());
    assert!(!dir.path("after.json").exists());
    drop(blocked);
    assert_eq!(fs::read(dir.path("blocked.sqlite")).unwrap(), b"cache");
    assert_eq!(fs::read(dir.path("cleanup.lock")).unwrap(), b"owned");
}

#[test]
fn cleanup_owned_release_never_removes_an_equal_content_replacement_lease() {
    let dir = Directory::new();
    let guard = dir.guard("cleanup.lock", b"owner");
    fs::rename(dir.path("cleanup.lock"), dir.path("old.lock")).unwrap();
    fs::write(dir.path("cleanup.lock"), b"owner").unwrap();
    let request = dir.request("removeOwnedFile", "cleanup.lock", json!({"identity": guard["identity"]}));
    assert!(execute(&request).is_err());
    assert_eq!(fs::read(dir.path("cleanup.lock")).unwrap(), b"owner");
    assert!(dir.path("old.lock").exists());
    let current = crate::font_resource::activation_identity::inspect(&dir.path("cleanup.lock")).unwrap();
    execute(&dir.request("removeOwnedFile", "cleanup.lock", json!({"identity": current}))).unwrap();
    assert!(!dir.path("cleanup.lock").exists());
    assert!(dir.path("old.lock").exists());
}

#[test]
fn cleanup_pins_cache_and_nested_target_directories_against_rename() {
    let dir = Directory::new();
    fs::create_dir(dir.path("cache")).unwrap();
    fs::create_dir(dir.path("cache/data")).unwrap();
    fs::create_dir(dir.path("cache/locks")).unwrap();
    let guard = dir.guard("cache/locks/cleanup.lock", b"owner");
    fs::write(dir.path("cache/data/index.sqlite"), b"cache").unwrap();
    let request = dir.request("removeWithOwnedLocks", "cache/locks/cleanup.lock", json!({
        "rootPath": dir.path("cache"), "guards": [guard], "paths": [dir.path("cache/data/index.sqlite")],
    }));
    let result = cleanup::remove_with_owned_locks(&request, || {
        assert!(fs::rename(dir.path("cache/data"), dir.path("moved-data")).is_err());
        assert!(fs::rename(dir.path("cache/locks"), dir.path("moved-locks")).is_err());
        assert!(fs::rename(dir.path("cache"), dir.path("moved-cache")).is_err());
    }).unwrap();
    assert_eq!(result[0]["status"], "removed");
    assert!(!dir.path("cache/data/index.sqlite").exists());
    fs::rename(dir.path("cache"), dir.path("released-cache")).unwrap();
}

#[test]
fn cleanup_rejects_outside_targets_before_touching_an_in_scope_target() {
    let dir = Directory::new();
    let outside = Directory::new();
    let guard = dir.guard("cleanup.lock", b"owner");
    fs::write(dir.path("index.sqlite"), b"inside").unwrap();
    fs::write(outside.path("keep.ttf"), b"outside").unwrap();
    let request = dir.request("removeWithOwnedLocks", "cleanup.lock", json!({
        "guards": [guard], "paths": [dir.path("index.sqlite"), outside.path("keep.ttf")],
    }));
    assert!(cleanup::remove_with_owned_locks(&request, || panic!("outside targets must reject the batch")).is_err());
    assert_eq!(fs::read(dir.path("index.sqlite")).unwrap(), b"inside");
    assert_eq!(fs::read(outside.path("keep.ttf")).unwrap(), b"outside");
}

#[test]
fn cleanup_missing_parent_never_unlinks_a_target_created_after_validation() {
    let dir = Directory::new();
    let guard = dir.guard("cleanup.lock", b"owner");
    let target = dir.path("later/index.sqlite");
    let request = dir.request("removeWithOwnedLocks", "cleanup.lock", json!({
        "guards": [guard], "paths": [target],
    }));
    let result = cleanup::remove_with_owned_locks(&request, || {
        fs::create_dir(dir.path("later")).unwrap();
        fs::write(&target, b"created after validation").unwrap();
    }).unwrap();
    assert_eq!(result[0]["status"], "missing");
    assert_eq!(fs::read(&target).unwrap(), b"created after validation");
}

#[test]
fn cleanup_missing_parent_cannot_be_replaced_by_a_junction_to_an_outside_file() {
    let dir = Directory::new();
    let outside = Directory::new();
    let guard = dir.guard("cleanup.lock", b"owner");
    let junction = dir.path("later");
    fs::write(outside.path("keep.ttf"), b"outside file").unwrap();
    let request = dir.request("removeWithOwnedLocks", "cleanup.lock", json!({
        "guards": [guard], "paths": [junction.join("keep.ttf")],
    }));
    let result = cleanup::remove_with_owned_locks(&request, || {
        create_junction(&junction, &outside.0);
    }).unwrap();
    assert_eq!(result[0]["status"], "missing");
    assert_eq!(fs::read(outside.path("keep.ttf")).unwrap(), b"outside file");
    fs::remove_dir(&junction).unwrap();
}

#[test]
fn preview_snapshot_is_read_only_and_does_not_create_a_missing_database() {
    let dir = Directory::new();
    assert!(cleanup::preview_rows(&dir.preview_request("previewCleanupRows", &[])).is_err());
    assert!(!dir.path("preview.sqlite").exists());
    let db = dir.preview_db();
    dir.preview_row(&db, KEY_A, &dir.png(KEY_A));
    drop(db);
    let before = fs::read(dir.path("preview.sqlite")).unwrap();
    assert_eq!(cleanup::preview_rows(&dir.preview_request("previewCleanupRows", &[])).unwrap(), json!([KEY_A]));
    assert_eq!(fs::read(dir.path("preview.sqlite")).unwrap(), before);
    assert!(!dir.path("preview.sqlite-wal").exists());
    assert!(!dir.path("preview.sqlite-journal").exists());
    assert!(dir.row_exists(KEY_A));
}

#[test]
fn preview_busy_key_keeps_its_database_row_png_and_lock_while_other_keys_continue() {
    let dir = Directory::new();
    let db = dir.preview_db();
    for key in [KEY_A, KEY_B] {
        dir.preview_row(&db, key, &dir.png(key));
        fs::write(dir.png(key), key.as_bytes()).unwrap();
    }
    drop(db);
    fs::write(dir.publish_lock(KEY_A), b"active publisher payload").unwrap();
    let writer = fs::OpenOptions::new().read(true).write(true).share_mode(0).open(dir.publish_lock(KEY_A)).unwrap();
    let result = cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A, KEY_B])).unwrap();
    assert_eq!(outcome(&result, KEY_A)["status"], "failed");
    assert_eq!(outcome(&result, KEY_A)["rowsCommitted"], false);
    assert_eq!(outcome(&result, KEY_B)["status"], "removed");
    assert_eq!(outcome(&result, KEY_B)["rowsCommitted"], true);
    assert!(dir.row_exists(KEY_A));
    assert!(!dir.row_exists(KEY_B));
    assert_eq!(fs::read(dir.png(KEY_A)).unwrap(), KEY_A.as_bytes());
    assert!(!dir.png(KEY_B).exists());
    assert!(!dir.publish_lock(KEY_B).exists());
    drop(writer);
    assert_eq!(fs::read(dir.publish_lock(KEY_A)).unwrap(), b"active publisher payload");
}

#[test]
fn preview_future_unknown_or_missing_schema_preserves_rows_and_files() {
    let dir = Directory::new();
    let db = dir.preview_db();
    dir.preview_row(&db, KEY_A, &dir.png(KEY_A));
    fs::write(dir.png(KEY_A), b"retained preview").unwrap();
    for version in [Some("999"), Some("unknown"), Some(""), None] {
        db.execute("DELETE FROM meta WHERE key='schemaVersion'", []).unwrap();
        if let Some(version) = version {
            db.execute("INSERT INTO meta(key,value) VALUES ('schemaVersion',?)", [version]).unwrap();
        }
        let before = fs::read(dir.path("preview.sqlite")).unwrap();
        assert!(cleanup::preview_rows(&dir.preview_request("previewCleanupRows", &[])).is_err());
        assert_preview_rejected(cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A])), KEY_A);
        assert_eq!(fs::read(dir.path("preview.sqlite")).unwrap(), before);
        assert!(dir.row_exists(KEY_A));
        assert_eq!(fs::read(dir.png(KEY_A)).unwrap(), b"retained preview");
        assert!(!dir.publish_lock(KEY_A).exists());
    }
}

#[test]
fn preview_database_only_row_is_removed_without_deleting_the_container_or_metadata() {
    let dir = Directory::new();
    let db = dir.preview_db();
    dir.preview_row(&db, KEY_A, &dir.png(KEY_A));
    db.execute("INSERT INTO meta(key,value) VALUES ('keep-marker','preserve')", []).unwrap();
    drop(db);
    let identity = crate::font_resource::activation_identity::file_id(&fs::File::open(dir.path("preview.sqlite")).unwrap()).unwrap();
    let result = cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A])).unwrap();
    assert_eq!(outcome(&result, KEY_A)["status"], "removed");
    assert_eq!(outcome(&result, KEY_A)["rowsCommitted"], true);
    assert!(!dir.row_exists(KEY_A));
    assert!(dir.path("images").is_dir());
    assert!(!dir.publish_lock(KEY_A).exists());
    let after_identity = crate::font_resource::activation_identity::file_id(&fs::File::open(dir.path("preview.sqlite")).unwrap()).unwrap();
    assert_eq!(identity, after_identity);
    let db = Connection::open_with_flags(dir.path("preview.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(db.query_row("SELECT value FROM meta WHERE key='keep-marker'", [], |row| row.get::<_, String>(0)).unwrap(), "preserve");
}

#[test]
fn preview_commit_then_png_unlink_failure_reports_committed_rows_and_continues() {
    let dir = Directory::new();
    let db = dir.preview_db();
    for key in [KEY_A, KEY_B] {
        dir.preview_row(&db, key, &dir.png(key));
        fs::write(dir.png(key), b"preview").unwrap();
    }
    drop(db);
    let blocked = fs::OpenOptions::new().read(true).share_mode(0).open(dir.png(KEY_A)).unwrap();
    let result = cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A, KEY_B])).unwrap();
    assert_eq!(outcome(&result, KEY_A)["status"], "failed");
    assert_eq!(outcome(&result, KEY_A)["rowsCommitted"], true);
    assert!(!outcome(&result, KEY_A)["message"].as_str().unwrap().is_empty());
    assert_eq!(outcome(&result, KEY_B)["status"], "removed");
    assert!(!dir.row_exists(KEY_A));
    assert!(!dir.row_exists(KEY_B));
    assert!(!dir.png(KEY_B).exists());
    assert!(!dir.publish_lock(KEY_A).exists());
    assert!(!dir.publish_lock(KEY_B).exists());
    drop(blocked);
    assert_eq!(fs::read(dir.png(KEY_A)).unwrap(), b"preview");
}

#[test]
fn preview_sql_delete_failure_rolls_back_and_preserves_png() {
    let dir = Directory::new();
    let db = dir.preview_db();
    dir.preview_row(&db, KEY_A, &dir.png(KEY_A));
    fs::write(dir.png(KEY_A), b"preview").unwrap();
    db.execute_batch("CREATE TRIGGER reject_cleanup BEFORE DELETE ON preview_cache BEGIN SELECT RAISE(ABORT,'fixture delete failure'); END;").unwrap();
    drop(db);
    let result = cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A])).unwrap();
    assert_eq!(outcome(&result, KEY_A)["status"], "failed");
    assert_eq!(outcome(&result, KEY_A)["rowsCommitted"], false);
    assert!(outcome(&result, KEY_A)["message"].as_str().unwrap().contains("fixture delete failure"));
    assert!(dir.row_exists(KEY_A));
    assert_eq!(fs::read(dir.png(KEY_A)).unwrap(), b"preview");
    assert!(!dir.publish_lock(KEY_A).exists());
}

#[test]
fn preview_sql_commit_busy_rolls_back_before_any_png_is_unlinked() {
    let dir = Directory::new();
    let db = dir.preview_db();
    dir.preview_row(&db, KEY_A, &dir.png(KEY_A));
    fs::write(dir.png(KEY_A), b"preview").unwrap();
    // A rollback-journal reader permits BEGIN IMMEDIATE and DELETE but blocks
    // the exclusive lock needed by COMMIT, exercising the commit error path.
    db.execute_batch("PRAGMA journal_mode=DELETE; BEGIN DEFERRED;").unwrap();
    assert_eq!(db.query_row("SELECT COUNT(*) FROM preview_cache", [], |row| row.get::<_, i64>(0)).unwrap(), 1);
    let result = cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A])).unwrap();
    assert_eq!(outcome(&result, KEY_A)["status"], "failed");
    assert_eq!(outcome(&result, KEY_A)["rowsCommitted"], false);
    db.execute_batch("ROLLBACK").unwrap();
    drop(db);
    assert!(dir.row_exists(KEY_A));
    assert_eq!(fs::read(dir.png(KEY_A)).unwrap(), b"preview");
    assert!(!dir.publish_lock(KEY_A).exists());
}

#[test]
fn preview_snapshot_cleanup_ignores_arbitrary_output_paths_and_later_different_keys() {
    let dir = Directory::new();
    let outside = Directory::new();
    let db = dir.preview_db();
    let unrelated = dir.path("unrelated.ttf");
    let external = outside.path("outside.png");
    fs::write(&unrelated, b"unrelated local file").unwrap();
    fs::write(&external, b"outside file").unwrap();
    dir.preview_row(&db, KEY_A, &unrelated);
    dir.preview_row(&db, KEY_B, &external);
    for key in [KEY_A, KEY_B] { fs::write(dir.png(key), b"old preview").unwrap(); }
    let snapshot = cleanup::preview_rows(&dir.preview_request("previewCleanupRows", &[])).unwrap();
    let keys: Vec<&str> = snapshot.as_array().unwrap().iter().map(|key| key.as_str().unwrap()).collect();
    assert_eq!(keys.len(), 2);
    // A later publisher for another key must survive this snapshot's cleanup.
    dir.preview_row(&db, KEY_C, &dir.png(KEY_C));
    fs::write(dir.png(KEY_C), b"new preview").unwrap();
    fs::write(dir.publish_lock(KEY_C), b"other publisher lease").unwrap();
    drop(db);
    let result = cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &keys)).unwrap();
    assert!(result.as_array().unwrap().iter().all(|row| row["status"] == "removed"));
    assert!(!dir.row_exists(KEY_A));
    assert!(!dir.row_exists(KEY_B));
    assert!(dir.row_exists(KEY_C));
    assert!(!dir.png(KEY_A).exists());
    assert!(!dir.png(KEY_B).exists());
    assert_eq!(fs::read(dir.png(KEY_C)).unwrap(), b"new preview");
    assert_eq!(fs::read(dir.publish_lock(KEY_C)).unwrap(), b"other publisher lease");
    assert_eq!(fs::read(&unrelated).unwrap(), b"unrelated local file");
    assert_eq!(fs::read(&external).unwrap(), b"outside file");
}

#[test]
fn preview_missing_database_allows_orphan_cleanup_without_creating_a_database() {
    let dir = Directory::new();
    fs::create_dir(dir.path("images")).unwrap();
    fs::write(dir.png(KEY_A), b"orphan preview").unwrap();
    let result = cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A])).unwrap();
    assert_eq!(outcome(&result, KEY_A)["status"], "removed");
    assert_eq!(outcome(&result, KEY_A)["rowsCommitted"], false);
    assert!(!dir.png(KEY_A).exists());
    assert!(!dir.path("preview.sqlite").exists());
    assert!(!dir.publish_lock(KEY_A).exists());
    assert!(dir.path("images").is_dir());
}

#[test]
fn preview_cleanup_only_removes_known_sidecars_for_the_selected_key() {
    let dir = Directory::new();
    let db = dir.preview_db();
    dir.preview_row(&db, KEY_A, &dir.png(KEY_A));
    drop(db);
    let metadata = dir.path("images").join(format!("{KEY_A}.png.meta.json"));
    let temporary = dir.path("images").join(format!("{KEY_A}.png.tmp.01234567-89ab-4cde-8fab-0123456789ab"));
    let unrelated = dir.path("images").join(format!("{KEY_A}.png.notes.txt"));
    let overlapping_key = dir.path("images").join(format!("{KEY_A}.png.other.png"));
    for path in [&metadata, &temporary, &unrelated, &overlapping_key] { fs::write(path, b"fixture").unwrap(); }
    fs::write(dir.png(KEY_A), b"preview").unwrap();
    let result = cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A])).unwrap();
    assert_eq!(outcome(&result, KEY_A)["status"], "removed");
    assert!(!dir.png(KEY_A).exists());
    assert!(!metadata.exists());
    assert!(!temporary.exists());
    assert_eq!(fs::read(&unrelated).unwrap(), b"fixture");
    assert_eq!(fs::read(&overlapping_key).unwrap(), b"fixture");
    assert!(!dir.publish_lock(KEY_A).exists());
}

#[test]
fn preview_cleanup_rejects_an_images_junction_without_touching_outside_files() {
    let dir = Directory::new();
    let outside = Directory::new();
    let db = dir.preview_db();
    dir.preview_row(&db, KEY_A, &dir.png(KEY_A));
    drop(db);
    fs::remove_dir(dir.path("images")).unwrap();
    create_junction(&dir.path("images"), &outside.0);
    let outside_png = outside.path(&format!("{KEY_A}.png"));
    fs::write(&outside_png, b"outside preview").unwrap();
    assert!(cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A])).is_err());
    assert!(dir.row_exists(KEY_A));
    assert_eq!(fs::read(&outside_png).unwrap(), b"outside preview");
    assert!(!outside.path(&format!("{KEY_A}.png.publish.lock")).exists());
    fs::remove_dir(dir.path("images")).unwrap();
}

#[test]
fn preview_invalid_windows_keys_reject_the_batch_before_deleting_valid_entries() {
    let dir = Directory::new();
    let db = dir.preview_db();
    dir.preview_row(&db, KEY_A, &dir.png(KEY_A));
    fs::write(dir.png(KEY_A), b"retained preview").unwrap();
    drop(db);
    for invalid in ["../outside", "..\\outside", "C:outside", "key:stream", ".", "..", "", "key\0tail", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] {
        assert!(cleanup::preview_entries(&dir.preview_request("previewCleanupEntries", &[KEY_A, invalid])).is_err());
        assert!(dir.row_exists(KEY_A));
        assert_eq!(fs::read(dir.png(KEY_A)).unwrap(), b"retained preview");
        assert!(!dir.publish_lock(KEY_A).exists());
    }
}
