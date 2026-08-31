use rusqlite::{params, Connection};

pub fn initialize_install_status_db(conn: &Connection, root_path: &str) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE IF NOT EXISTS install_status (
           font_id TEXT PRIMARY KEY,
           signature TEXT NOT NULL DEFAULT '',
           installed INTEGER NOT NULL DEFAULT 0,
           by_type TEXT NOT NULL DEFAULT 'none',
           matches_json TEXT NOT NULL DEFAULT '[]',
           checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
           system_default INTEGER NOT NULL DEFAULT 0
         );",
    )?;
    ensure_install_status_columns(conn)?;
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_install_status_installed ON install_status(installed);
         CREATE INDEX IF NOT EXISTS idx_install_status_by_type ON install_status(by_type);
         CREATE INDEX IF NOT EXISTS idx_install_status_system_default ON install_status(system_default);",
    )?;
    set_meta(conn, "schemaVersion", "1")?;
    set_meta(conn, "cacheArchitecture", "v1-clean-machine-install")?;
    set_meta(conn, "rootPath", root_path)?;
    Ok(())
}

pub fn ensure_install_status_columns(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(install_status)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut names = std::collections::HashSet::new();
    for row in rows {
        names.insert(row?);
    }
    add_column(conn, &mut names, "signature", "TEXT NOT NULL DEFAULT ''")?;
    add_column(conn, &mut names, "installed", "INTEGER NOT NULL DEFAULT 0")?;
    add_column(conn, &mut names, "by_type", "TEXT NOT NULL DEFAULT 'none'")?;
    add_column(conn, &mut names, "matches_json", "TEXT NOT NULL DEFAULT '[]'")?;
    add_column(conn, &mut names, "checked_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP")?;
    add_column(conn, &mut names, "system_default", "INTEGER NOT NULL DEFAULT 0")?;
    Ok(())
}

fn add_column(
    conn: &Connection,
    names: &mut std::collections::HashSet<String>,
    name: &str,
    definition: &str,
) -> rusqlite::Result<()> {
    if !names.contains(name) {
        conn.execute_batch(&format!(
            "ALTER TABLE install_status ADD COLUMN {} {}",
            name, definition
        ))?;
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
