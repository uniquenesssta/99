use rusqlite::{params, Connection};

pub fn initialize_shared_metadata_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS font_metadata (
           font_id TEXT PRIMARY KEY,
           relative_path TEXT,
           path_key TEXT,
           tag_names_json TEXT NOT NULL DEFAULT '[]',
           favorite INTEGER NOT NULL DEFAULT 0,
           delete_protected INTEGER NOT NULL DEFAULT 0,
           revision INTEGER NOT NULL DEFAULT 1,
           updated_at TEXT NOT NULL,
           updated_by TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_shared_metadata_relative_path ON font_metadata(relative_path);
         CREATE INDEX IF NOT EXISTS idx_shared_metadata_path_key ON font_metadata(path_key);
         CREATE TABLE IF NOT EXISTS metadata_events (
           event_id INTEGER PRIMARY KEY AUTOINCREMENT,
           event_type TEXT NOT NULL,
           font_id TEXT,
           relative_path TEXT,
           payload_json TEXT NOT NULL,
           created_at TEXT NOT NULL,
           writer_host TEXT,
           writer_pid INTEGER
         );
         CREATE INDEX IF NOT EXISTS idx_shared_metadata_events_created ON metadata_events(created_at);
         CREATE TABLE IF NOT EXISTS shared_tag_ops (
           op_id TEXT PRIMARY KEY,
           font_id TEXT NOT NULL,
           relative_path TEXT,
           path_key TEXT,
           action TEXT NOT NULL,
           tag_name TEXT NOT NULL,
           base_revision INTEGER NOT NULL DEFAULT 0,
           next_revision INTEGER NOT NULL DEFAULT 0,
           created_at TEXT NOT NULL,
           machine_id TEXT,
           writer_pid INTEGER,
           tombstone INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_font_tag ON shared_tag_ops(font_id, tag_name);
         CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_created ON shared_tag_ops(created_at);",
    )?;
    ensure_shared_metadata_columns(conn)?;
    set_meta(conn, "schemaVersion", "3")?;
    set_meta(conn, "cacheType", "shared-font-metadata")?;
    Ok(())
}

fn ensure_shared_metadata_columns(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(font_metadata)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut names = std::collections::HashSet::new();
    for row in rows {
        names.insert(row?);
    }
    add_column(conn, &mut names, "relative_path", "TEXT")?;
    add_column(conn, &mut names, "path_key", "TEXT")?;
    add_column(conn, &mut names, "tag_names_json", "TEXT NOT NULL DEFAULT '[]'")?;
    add_column(conn, &mut names, "favorite", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, &mut names, "delete_protected", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, &mut names, "revision", "INTEGER NOT NULL DEFAULT 1")?;
    add_column(conn, &mut names, "updated_at", "TEXT NOT NULL DEFAULT ''")?;
    add_column(conn, &mut names, "updated_by", "TEXT")?;
    Ok(())
}

fn add_column(
    conn: &Connection,
    names: &mut std::collections::HashSet<String>,
    name: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    if !names.contains(name) {
        conn.execute_batch(&format!("ALTER TABLE font_metadata ADD COLUMN {} {}", name, definition))?;
        names.insert(name.to_string());
    }
    Ok(())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}
