#![cfg(windows)]

use super::{execute, Request};
use rusqlite::{Connection, ErrorCode, OpenFlags};
use serde_json::{json, Value};
use std::{
    fs, io,
    os::windows::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{atomic::{AtomicU64, Ordering}, mpsc},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "hfm-sqlite-snapshot-{}-{}-{}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn path(&self, name: &str) -> PathBuf { self.0.join(name) }

    fn snapshot(&self, source: &str, target: &str) -> io::Result<Value> {
        let request: Request = serde_json::from_value(json!({
            "operation": "sqliteSnapshot",
            "path": self.path(source),
            "transferPath": self.path(target),
        })).unwrap();
        // Exactly one production request: Busy/Locked never triggers a test retry.
        execute(&request)
    }
}

impl Drop for Directory {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn read_only(path: &Path) -> Connection {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn integer(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn text(conn: &Connection, sql: &str) -> String {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn integrity(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut statement = conn.prepare("PRAGMA integrity_check")?;
    let rows = statement.query_map([], |row| row.get(0))?;
    rows.collect()
}

fn assert_integrity(conn: &Connection) {
    assert_eq!(integrity(conn).unwrap(), ["ok".to_owned()]);
}

fn sqlite_error_code(error: &io::Error) -> Option<ErrorCode> {
    match error.get_ref().and_then(|inner| inner.downcast_ref::<rusqlite::Error>()) {
        Some(rusqlite::Error::SqliteFailure(code, _)) => Some(code.code),
        _ => None,
    }
}

type SchemaRow = (String, String, String, i64, Option<String>);

fn schema(conn: &Connection) -> Vec<SchemaRow> {
    let mut statement = conn.prepare(
        "SELECT type,name,tbl_name,rootpage,sql FROM sqlite_schema ORDER BY type,name",
    ).unwrap();
    let rows = statement.query_map([], |row| Ok((
        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?,
    ))).unwrap();
    rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
}

fn implicit_rows(conn: &Connection) -> Vec<(i64, String)> {
    let mut statement = conn.prepare("SELECT rowid,payload FROM implicit_rows ORDER BY rowid").unwrap();
    let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
    rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
}

#[test]
fn sqlite_snapshot_preserves_rowids_schema_metadata_and_page_size() {
    let dir = Directory::new();
    let source = Connection::open(dir.path("source.sqlite")).unwrap();
    source.execute_batch(
        "PRAGMA page_size=1024;
         PRAGMA user_version=731;
         PRAGMA application_id=1212566867;
         CREATE TABLE implicit_rows(payload TEXT NOT NULL, ordinal INTEGER NOT NULL);
         CREATE TABLE audit(payload TEXT NOT NULL);
         CREATE INDEX implicit_payload ON implicit_rows(payload DESC);
         CREATE TRIGGER audit_insert AFTER INSERT ON implicit_rows
           BEGIN INSERT INTO audit(payload) VALUES (NEW.payload); END;
         CREATE VIEW selected_rows AS SELECT rowid AS original_rowid,payload FROM implicit_rows WHERE ordinal>0;
         CREATE TABLE sequence_rows(id INTEGER PRIMARY KEY AUTOINCREMENT,payload TEXT);
         CREATE TABLE keyed_rows(key TEXT PRIMARY KEY,value BLOB) WITHOUT ROWID;
         INSERT INTO implicit_rows(rowid,payload,ordinal) VALUES (7,'first',1),(101,'deleted',2),(9001,'last',3);
         DELETE FROM implicit_rows WHERE rowid=101;
         INSERT INTO sequence_rows(id,payload) VALUES (401,'deleted');
         DELETE FROM sequence_rows;
         INSERT INTO keyed_rows VALUES ('key',x'00ff1280');",
    ).unwrap();
    let expected_schema = schema(&source);
    let expected_rows = implicit_rows(&source);
    assert_eq!(expected_rows, [(7, "first".to_owned()), (9001, "last".to_owned())]);
    assert_eq!(integer(&source, "PRAGMA page_size"), 1024);

    dir.snapshot("source.sqlite", "snapshot.sqlite").unwrap();
    let snapshot = Connection::open(dir.path("snapshot.sqlite")).unwrap();
    assert_eq!(schema(&snapshot), expected_schema);
    assert_eq!(implicit_rows(&snapshot), expected_rows);
    assert_eq!(integer(&snapshot, "PRAGMA page_size"), 1024);
    assert_eq!(integer(&snapshot, "PRAGMA user_version"), 731);
    assert_eq!(integer(&snapshot, "PRAGMA application_id"), 1212566867);
    assert_eq!(text(&snapshot, "PRAGMA journal_mode"), "delete");
    assert_eq!(integer(&snapshot, "SELECT sum(original_rowid) FROM selected_rows"), 9008);
    assert_eq!(text(&snapshot, "SELECT hex(value) FROM keyed_rows WHERE key='key'"), "00FF1280");
    assert_eq!(integer(&snapshot, "SELECT count(*) FROM implicit_rows INDEXED BY implicit_payload WHERE payload='last'"), 1);
    assert_integrity(&snapshot);

    snapshot.execute("INSERT INTO implicit_rows(rowid,payload,ordinal) VALUES (9100,'target-only',4)", []).unwrap();
    assert_eq!(integer(&snapshot, "SELECT count(*) FROM audit WHERE payload='target-only'"), 1);
    snapshot.execute("INSERT INTO sequence_rows(payload) VALUES ('next')", []).unwrap();
    assert_eq!(integer(&snapshot, "SELECT id FROM sequence_rows"), 402);
    assert_eq!(implicit_rows(&source), expected_rows);
    assert_eq!(integer(&source, "SELECT count(*) FROM sequence_rows"), 0);
    source.execute("DELETE FROM implicit_rows", []).unwrap();
    assert_eq!(integer(&snapshot, "SELECT count(*) FROM implicit_rows"), 3);
}

#[test]
fn sqlite_snapshot_reads_uncheckpointed_wal_but_excludes_uncommitted_rows() {
    let dir = Directory::new();
    let source_path = dir.path("source.sqlite");
    let source = Connection::open(&source_path).unwrap();
    source.execute_batch("CREATE TABLE entries(value TEXT NOT NULL);").unwrap();
    assert_eq!(text(&source, "PRAGMA journal_mode=WAL"), "wal");
    source.execute_batch("PRAGMA wal_autocheckpoint=0;").unwrap();
    let checkpointed_bytes = fs::read(&source_path).unwrap();
    source.execute("INSERT INTO entries VALUES ('committed-in-wal')", []).unwrap();
    assert_eq!(fs::read(&source_path).unwrap(), checkpointed_bytes);
    assert!(fs::metadata(dir.path("source.sqlite-wal")).unwrap().len() > 32);

    // The copied main file has a valid schema but none of the committed WAL row.
    fs::copy(&source_path, dir.path("main-only.sqlite")).unwrap();
    let main_only = read_only(&dir.path("main-only.sqlite"));
    assert_eq!(integer(&main_only, "SELECT count(*) FROM entries"), 0);
    drop(main_only);
    source.execute_batch("BEGIN IMMEDIATE; INSERT INTO entries VALUES ('not-committed');").unwrap();
    assert_eq!(integer(&source, "SELECT count(*) FROM entries"), 2);
    let wal_before = fs::read(dir.path("source.sqlite-wal")).unwrap();

    let result = dir.snapshot("source.sqlite", "snapshot.sqlite");
    source.execute_batch("ROLLBACK;").unwrap();
    result.unwrap();
    let snapshot = read_only(&dir.path("snapshot.sqlite"));
    assert_eq!(integer(&snapshot, "SELECT count(*) FROM entries"), 1);
    assert_eq!(text(&snapshot, "SELECT value FROM entries"), "committed-in-wal");
    assert_integrity(&snapshot);
    assert_eq!(fs::read(&source_path).unwrap(), checkpointed_bytes);
    assert_eq!(fs::read(dir.path("source.sqlite-wal")).unwrap(), wal_before);
    assert_eq!(text(&source, "PRAGMA journal_mode"), "wal");
    assert_eq!(integer(&source, "PRAGMA wal_autocheckpoint"), 0);
}

#[test]
fn sqlite_snapshot_is_consistent_while_another_thread_holds_a_partial_write_transaction() {
    let dir = Directory::new();
    let source_path = dir.path("source.sqlite");
    let source = Connection::open(&source_path).unwrap();
    source.execute_batch(
        "PRAGMA journal_mode=WAL;
         PRAGMA wal_autocheckpoint=0;
         CREATE TABLE left_rows(id INTEGER PRIMARY KEY,generation INTEGER,payload BLOB);
         CREATE TABLE right_rows(id INTEGER PRIMARY KEY,generation INTEGER,payload BLOB);
         WITH RECURSIVE ids(id) AS (VALUES(1) UNION ALL SELECT id+1 FROM ids WHERE id<64)
           INSERT INTO left_rows SELECT id,1,zeroblob(2048) FROM ids;
         INSERT INTO right_rows SELECT * FROM left_rows;",
    ).unwrap();
    let (ready_tx, ready_rx) = mpsc::channel();
    let (commit_tx, commit_rx) = mpsc::channel();
    let writer = thread::spawn(move || {
        let writer = Connection::open(source_path).unwrap();
        writer.busy_timeout(Duration::ZERO).unwrap();
        writer.execute_batch(
            "PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=5;
             BEGIN IMMEDIATE; UPDATE left_rows SET generation=2,payload=zeroblob(3072);",
        ).unwrap();
        // SQL is already partially applied, including pages beyond the tiny cache.
        ready_tx.send((
            integer(&writer, "SELECT sum(generation) FROM left_rows"),
            integer(&writer, "SELECT sum(generation) FROM right_rows"),
        )).unwrap();
        commit_rx.recv_timeout(Duration::from_secs(30)).unwrap();
        writer.execute_batch("UPDATE right_rows SET generation=2,payload=zeroblob(3072); COMMIT;").unwrap();
    });

    let ready = ready_rx.recv_timeout(Duration::from_secs(30));
    // No scheduling sleep and no retry: the writer cannot commit until this one
    // production snapshot returns. This proves overlapping transactions, not a
    // fabricated claim that a commit occurred inside SQLite's single step call.
    let result = if ready.is_ok() { Some(dir.snapshot("source.sqlite", "snapshot.sqlite")) } else { None };
    let released = commit_tx.send(());
    let joined = writer.join();
    assert_eq!(ready.unwrap(), (128, 64));
    released.unwrap();
    joined.unwrap();
    result.unwrap().unwrap();

    let snapshot = read_only(&dir.path("snapshot.sqlite"));
    for table in ["left_rows", "right_rows"] {
        assert_eq!(integer(&snapshot, &format!("SELECT count(*) FROM {table}")), 64);
        assert_eq!(integer(&snapshot, &format!("SELECT sum(generation) FROM {table}")), 64);
        assert_eq!(integer(&snapshot, &format!("SELECT sum(length(payload)) FROM {table}")), 64 * 2048);
        assert_eq!(integer(&source, &format!("SELECT sum(generation) FROM {table}")), 128);
    }
    assert_integrity(&snapshot);
}

#[test]
fn sqlite_snapshot_works_with_a_windows_deny_write_source_handle_without_mutating_source() {
    let dir = Directory::new();
    let source_path = dir.path("source.sqlite");
    let source = Connection::open(&source_path).unwrap();
    source.execute_batch("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('read-only-source');").unwrap();
    source.close().unwrap();
    let before = fs::read(&source_path).unwrap();
    let modified = fs::metadata(&source_path).unwrap().modified().unwrap();
    // FILE_SHARE_READ only: a real Windows handle denies writes and replacement.
    let held = fs::OpenOptions::new().read(true).share_mode(0x00000001).open(&source_path).unwrap();
    assert!(fs::OpenOptions::new().write(true).open(&source_path).is_err());
    let result = dir.snapshot("source.sqlite", "snapshot.sqlite");
    drop(held);
    result.unwrap();
    assert_eq!(fs::read(&source_path).unwrap(), before);
    assert_eq!(fs::metadata(&source_path).unwrap().modified().unwrap(), modified);
    for suffix in ["-wal", "-shm", "-journal"] {
        assert!(!dir.path(&format!("source.sqlite{suffix}")).exists());
    }
    let snapshot = read_only(&dir.path("snapshot.sqlite"));
    assert_eq!(text(&snapshot, "SELECT value FROM entries"), "read-only-source");
    assert_integrity(&snapshot);
}

#[test]
fn sqlite_snapshot_refuses_existing_empty_nonempty_and_source_alias_targets() {
    let dir = Directory::new();
    let source_path = dir.path("source.sqlite");
    let source = Connection::open(&source_path).unwrap();
    source.execute_batch("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('preserved');").unwrap();
    source.close().unwrap();
    let original = fs::read(&source_path).unwrap();
    fs::write(dir.path("empty.sqlite"), []).unwrap();
    fs::write(dir.path("nonempty.sqlite"), b"preexisting target must survive").unwrap();
    fs::hard_link(&source_path, dir.path("source-alias.sqlite")).unwrap();
    for target in ["empty.sqlite", "nonempty.sqlite", "source.sqlite", "source-alias.sqlite"] {
        let before = fs::read(dir.path(target)).unwrap();
        assert!(dir.snapshot("source.sqlite", target).is_err(), "overwrote {target}");
        assert_eq!(fs::read(dir.path(target)).unwrap(), before, "changed {target}");
        assert_eq!(fs::read(&source_path).unwrap(), original);
    }
    fs::create_dir(dir.path("directory-target")).unwrap();
    fs::write(dir.path("directory-target/preserved"), b"directory contents").unwrap();
    assert!(dir.snapshot("source.sqlite", "directory-target").is_err());
    assert!(dir.path("directory-target").is_dir());
    assert_eq!(fs::read(dir.path("directory-target/preserved")).unwrap(), b"directory contents");
    assert_eq!(fs::read(&source_path).unwrap(), original);
}

#[test]
fn sqlite_snapshot_production_handles_pin_target_and_directory_until_each_is_released() {
    let dir = Directory::new();
    let owned = dir.path("owned");
    let moved_directory = dir.path("moved-owned");
    fs::create_dir(&owned).unwrap();
    let target = owned.join("snapshot.sqlite");
    let moved_target = owned.join("moved.sqlite");
    // Use the exact production helpers, not a duplicate of their open flags.
    let directory_pins = super::cleanup::pin_cache_directories(&owned, &owned).unwrap();
    let reserved = super::sqlite_snapshot::reserve_target(&target).unwrap();
    assert!(super::sqlite_snapshot::reserve_target(&target).is_err());
    let destination = Connection::open_with_flags(&target, OpenFlags::SQLITE_OPEN_READ_WRITE).unwrap();
    destination.execute_batch("CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES ('committed');").unwrap();
    assert_eq!(text(&destination, "SELECT value FROM entries"), "committed");
    destination.close().unwrap();

    // SQLite is already closed: the retained production handles must be the
    // reason replacement is denied, rather than an unrelated SQLite open file.
    assert!(fs::rename(&target, &moved_target).is_err());
    assert!(target.is_file());
    assert!(!moved_target.exists());
    assert!(fs::rename(&owned, &moved_directory).is_err());
    assert!(owned.is_dir());
    assert!(!moved_directory.exists());

    drop(reserved);
    fs::rename(&target, &moved_target).unwrap();
    assert!(!target.exists());
    assert!(moved_target.is_file());
    assert!(fs::rename(&owned, &moved_directory).is_err());
    drop(directory_pins);
    fs::rename(&owned, &moved_directory).unwrap();
    assert!(!owned.exists());
    let snapshot = read_only(&moved_directory.join("moved.sqlite"));
    assert_eq!(text(&snapshot, "SELECT value FROM entries"), "committed");
    assert_integrity(&snapshot);
}

fn corrupt_btree_fixture(dir: &Directory, index: bool) -> Vec<u8> {
    let source_path = dir.path("source.sqlite");
    let source = Connection::open(&source_path).unwrap();
    source.execute_batch(
        "PRAGMA page_size=1024;
         CREATE TABLE entries(id INTEGER PRIMARY KEY,value TEXT NOT NULL);
         CREATE INDEX entries_value ON entries(value);
         INSERT INTO entries VALUES (1,'alpha'),(2,'beta'),(3,'gamma');",
    ).unwrap();
    assert_integrity(&source);
    let object = if index { "entries_value" } else { "entries" };
    let root_page: i64 = source.query_row(
        "SELECT rootpage FROM sqlite_schema WHERE name=?1", [object], |row| row.get(0),
    ).unwrap();
    let page_size = integer(&source, "PRAGMA page_size") as usize;
    source.close().unwrap();
    assert!(root_page > 1);
    let mut bytes = fs::read(&source_path).unwrap();
    let header = bytes[..100].to_vec();
    let start = (root_page as usize - 1) * page_size;
    if index {
        assert_eq!(bytes[start], 0x0a, "fixture needs a real index leaf page");
        // Keep a structurally valid, correctly ordered index. Only its stored
        // key differs from the table, so merely copying or opening it succeeds.
        let matches: Vec<_> = bytes[start..start + page_size].windows(5)
            .enumerate().filter(|(_, value)| *value == b"gamma").map(|(offset, _)| offset).collect();
        assert_eq!(matches.len(), 1);
        bytes[start + matches[0] + 4] = b'X';
    } else {
        assert_eq!(bytes[start], 0x0d, "fixture needs a real table leaf page");
        bytes[start] = 0x7f; // Invalid B-tree page type; SQLite file header stays valid.
    }
    assert_eq!(&bytes[..100], header.as_slice());
    assert_eq!(&bytes[..16], b"SQLite format 3\0");
    fs::write(&source_path, &bytes).unwrap();
    bytes
}

fn assert_corrupt_snapshot_rejected(index: bool) {
    let dir = Directory::new();
    let corrupt_bytes = corrupt_btree_fixture(&dir, index);
    let source = read_only(&dir.path("source.sqlite"));
    assert_eq!(integer(&source, "SELECT count(*) FROM sqlite_schema WHERE name IN ('entries','entries_value')"), 2);
    if index {
        assert_eq!(integer(&source, "SELECT count(*) FROM entries NOT INDEXED"), 3);
        assert_eq!(text(&source, "SELECT value FROM entries NOT INDEXED WHERE id=3"), "gamma");
        assert_eq!(text(&source, "SELECT value FROM entries INDEXED BY entries_value WHERE value>'beta'"), "gammX");
    }
    match integrity(&source) {
        Ok(messages) => assert_ne!(messages, ["ok".to_owned()], "fixture did not corrupt a B-tree"),
        Err(rusqlite::Error::SqliteFailure(code, _)) => assert_eq!(code.code, ErrorCode::DatabaseCorrupt),
        Err(error) => panic!("unexpected corruption fixture error: {error}"),
    }
    source.close().unwrap();
    let error = dir.snapshot("source.sqlite", "snapshot.sqlite").unwrap_err();
    assert_eq!(sqlite_error_code(&error), Some(ErrorCode::DatabaseCorrupt), "{error}");
    assert_eq!(fs::read(dir.path("source.sqlite")).unwrap(), corrupt_bytes);
    // Failed output cleanup belongs to the transport. The native command must
    // reject the image, not report a successful path to these copied bad pages.
}

#[test]
fn sqlite_snapshot_rejects_a_corrupt_table_btree_with_a_valid_sqlite_header() {
    assert_corrupt_snapshot_rejected(false);
}

#[test]
fn sqlite_snapshot_rejects_logical_index_corruption_that_a_page_copy_preserves() {
    assert_corrupt_snapshot_rejected(true);
}
