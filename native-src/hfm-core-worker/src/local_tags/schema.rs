use rusqlite::{params, Connection};

pub fn initialize_local_tags_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         CREATE TABLE IF NOT EXISTS app_state (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS meta (
           key TEXT PRIMARY KEY,
           value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS local_font_tags (
           font_id TEXT NOT NULL,
           font_path TEXT NOT NULL DEFAULT '',
           tag_name TEXT NOT NULL,
           updated_at TEXT NOT NULL,
           PRIMARY KEY(font_id, tag_name)
         );"
    )?;
    let _ = conn.execute_batch("ALTER TABLE local_font_tags ADD COLUMN font_path TEXT NOT NULL DEFAULT '';");
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_local_font_tags_tag ON local_font_tags(tag_name, font_id);
         CREATE INDEX IF NOT EXISTS idx_local_font_tags_path ON local_font_tags(font_path, tag_name);
         CREATE INDEX IF NOT EXISTS idx_local_font_tags_tag_path ON local_font_tags(tag_name, font_path);"
    )?;
    set_meta(conn, "schemaVersion", "100")?;
    set_meta(conn, "cacheArchitecture", "v1-clean-shared-root")?;
    Ok(())
}

pub fn set_meta(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}

pub fn set_app_state(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)",
        params![key, value],
    )?;
    Ok(())
}
