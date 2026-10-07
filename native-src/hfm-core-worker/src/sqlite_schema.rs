use rusqlite::{params, Connection, OptionalExtension};

pub(crate) fn assert_supported_version(conn: &Connection, keys: &[&str], supported: i64) -> rusqlite::Result<()> {
    let exists: i64 = conn.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='meta'", [], |row| row.get(0))?;
    if exists == 0 { return Ok(()); }
    for key in keys {
        let value: Option<String> = conn.query_row("SELECT value FROM meta WHERE key=?", params![key], |row| row.get(0)).optional()?;
        if let Some(text) = value {
            if !text.parse::<i64>().ok().is_some_and(|value| value >= 0 && value <= supported) {
                return Err(rusqlite::Error::InvalidParameterName(format!("HFM_SQLITE_VERSION_UNSUPPORTED: {key}={text}")));
            }
        }
    }
    Ok(())
}
