use std::collections::HashSet;

use rusqlite::{params, Connection};

pub fn initialize_preview_cache_db(conn: &Connection, schema_version: i64) -> rusqlite::Result<()> {
    crate::sqlite_schema::assert_supported_version(conn, &["schemaVersion"], schema_version)?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS preview_cache (
           preview_key TEXT PRIMARY KEY,
           font_id TEXT,
           source_path TEXT,
           root_path TEXT,
           relative_path TEXT NOT NULL,
           output_path TEXT NOT NULL,
           font_signature TEXT NOT NULL,
           text_hash TEXT NOT NULL,
           font_size INTEGER NOT NULL,
           width INTEGER NOT NULL,
           height INTEGER NOT NULL,
           storage TEXT NOT NULL,
           status TEXT NOT NULL,
           message TEXT,
           fail_count INTEGER NOT NULL DEFAULT 0,
           generated_at TEXT,
           accessed_at TEXT,
           updated_at TEXT NOT NULL
         );",
    )?;
    ensure_preview_cache_columns(conn)?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_preview_cache_relative_path ON preview_cache(relative_path);
         CREATE INDEX IF NOT EXISTS idx_preview_cache_source_path ON preview_cache(source_path);
         CREATE INDEX IF NOT EXISTS idx_preview_cache_root_path ON preview_cache(root_path);
         CREATE INDEX IF NOT EXISTS idx_preview_cache_status ON preview_cache(status);
         CREATE INDEX IF NOT EXISTS idx_preview_cache_accessed ON preview_cache(accessed_at);
         CREATE INDEX IF NOT EXISTS idx_preview_cache_storage ON preview_cache(storage);",
    )?;
    conn.execute("UPDATE preview_cache SET updated_at=COALESCE(generated_at, accessed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE updated_at=''", [])?;
    set_meta(conn, "schemaVersion", &schema_version.to_string())?;
    Ok(())
}

fn ensure_preview_cache_columns(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(preview_cache)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut names = HashSet::new();
    for row in rows {
        names.insert(row?);
    }
    add_column(conn, &mut names, "font_id", "TEXT")?;
    add_column(conn, &mut names, "source_path", "TEXT")?;
    add_column(conn, &mut names, "root_path", "TEXT")?;
    add_column(conn, &mut names, "message", "TEXT")?;
    add_column(conn, &mut names, "fail_count", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, &mut names, "generated_at", "TEXT")?;
    add_column(conn, &mut names, "accessed_at", "TEXT")?;
    add_column(conn, &mut names, "updated_at", "TEXT NOT NULL DEFAULT ''")?;
    Ok(())
}

fn add_column(conn: &Connection, names: &mut HashSet<String>, name: &str, definition: &str) -> rusqlite::Result<()> {
    if !names.contains(name) {
        conn.execute_batch(&format!("ALTER TABLE preview_cache ADD COLUMN {} {}", name, definition))?;
        names.insert(name.to_string());
    }
    Ok(())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", params![key, value])?;
    Ok(())
}


fn cache_failure(kind: &str, detail: impl std::fmt::Display) -> String {
    format!("[HFM_PREVIEW_CACHE:{}] preview-cache-{}: {}", kind, kind, detail)
}

pub(super) fn cache_sqlite_failure(error: rusqlite::Error) -> String {
    let kind = match &error {
        rusqlite::Error::SqliteFailure(code, _) => match code.code {
            rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked => "busy",
            rusqlite::ErrorCode::PermissionDenied | rusqlite::ErrorCode::ReadOnly
                | rusqlite::ErrorCode::AuthorizationForStatementDenied => "denied",
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase => "corrupt",
            _ => "unavailable",
        },
        _ => "unavailable",
    };
    cache_failure(kind, error)
}

/// Readers never create, migrate or repair optional caches. An absent database
/// is distinct from an existing database that SQLite cannot open.
pub fn open_preview_cache_query(path: &str, version: i64, read_only: bool) -> Result<Connection, String> {
    if !read_only {
        if let Some(parent) = std::path::Path::new(path).parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let conn = Connection::open(path).map_err(|error| error.to_string())?;
        initialize_preview_cache_db(&conn, version).map_err(|error| error.to_string())?;
        return Ok(conn);
    }
    match std::fs::metadata(path) {
        Ok(_) => {},
        Err(error) => return Err(cache_failure(match error.kind() {
            std::io::ErrorKind::NotFound => "missing",
            std::io::ErrorKind::PermissionDenied => "denied",
            _ => "unavailable",
        }, error)),
    }
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(cache_sqlite_failure)?;
    let tables: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('meta','preview_cache')", [], |row| row.get(0))
        .map_err(cache_sqlite_failure)?;
    if tables != 2 { return Err(cache_failure("incompatible", "missing tables")); }
    let mut columns = conn.prepare("PRAGMA table_info(preview_cache)").map_err(cache_sqlite_failure)?;
    let names = columns.query_map([], |row| row.get::<_,String>(1)).map_err(cache_sqlite_failure)?
        .collect::<rusqlite::Result<HashSet<_>>>().map_err(cache_sqlite_failure)?;
    if !["preview_key","output_path","status"].iter().all(|name|names.contains(*name)) { return Err(cache_failure("incompatible", "missing columns")); }
    drop(columns);
    let schema: String = conn.query_row("SELECT value FROM meta WHERE key = 'schemaVersion'", [], |row| row.get(0))
        .map_err(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => cache_failure("incompatible", "schemaVersion missing"),
            other => cache_sqlite_failure(other),
        })?;
    if schema != version.to_string() { return Err(cache_failure("incompatible", "schemaVersion")); }
    Ok(conn)
}

#[cfg(test)]
mod legacy_schema {
    use super::*;
    #[test]
    fn populated_preview_adds_constant_default_before_indexes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE preview_cache(preview_key TEXT PRIMARY KEY,relative_path TEXT,output_path TEXT,font_signature TEXT,text_hash TEXT,font_size INTEGER,width INTEGER,height INTEGER,storage TEXT,status TEXT);
          INSERT INTO preview_cache VALUES('old','font.ttf','keep.png','sig','text',12,100,30,'root','ok');").unwrap();
        initialize_preview_cache_db(&conn, 1).unwrap();
        initialize_preview_cache_db(&conn, 1).unwrap();
        let (output, timestamp): (String, String) = conn.query_row("SELECT output_path,updated_at FROM preview_cache", [], |row| Ok((row.get(0)?, row.get(1)?))).unwrap();
        assert_eq!(output, "keep.png"); assert!(!timestamp.is_empty());
        conn.execute("UPDATE meta SET value='999' WHERE key='schemaVersion'", []).unwrap();
        assert!(initialize_preview_cache_db(&conn, 1).is_err());
    }
}
