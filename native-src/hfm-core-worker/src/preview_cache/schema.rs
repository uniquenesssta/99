use std::collections::HashSet;

use rusqlite::{params, Connection};

pub fn initialize_preview_cache_db(conn: &Connection, schema_version: i64) -> rusqlite::Result<()> {
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
    add_column(conn, &mut names, "updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP")?;
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

