use rusqlite::{functions::FunctionFlags, Connection};
use serde_json::Value;
use sha1::{Digest, Sha1};
use crate::merged_index::path_utils::{file_name_from_path, file_runtime_font_id, runtime_path};

pub const INSTALL_STATUS_PROJECTION_VERSION: &str = "content-signature-v1";

// Match normalizePathForCacheCompare, not concrete-ID normalization: the
// writer intentionally retains repeated separators and managed-field spelling.
fn signature_path(value: &str) -> String {
    let mut path = value.trim().replace('/', "\\");
    let upper = path.to_ascii_uppercase();
    if upper.starts_with("\\\\?\\UNC\\") { path = format!("\\\\{}", &path[8..]); }
    else if upper.starts_with("\\\\?\\") { path = path[4..].to_string(); }
    let bytes = path.as_bytes();
    if (bytes.len() == 2 || (bytes.len() == 3 && bytes[2] == b'\\'))
        && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' { path = format!("{}\\", &path[..2]); }
    else { path = path.trim_end_matches('\\').to_string(); }
    path.to_lowercase()
}
fn js_round(value: f64) -> i64 {
    let floor = value.floor();
    (floor + if value - floor >= 0.5 { 1.0 } else { 0.0 }) as i64
}

pub fn install_status_signature(id: &str, path: &str, name: &str, size: f64, mtime: f64, managed_path: &str, registry: &str) -> String {
    let input = format!("{}|{}|{}|{}|{}|{}|{}", id, signature_path(path), name,
        js_round(size), js_round(mtime), managed_path, registry);
    format!("content-v1:{:x}", Sha1::digest(input.as_bytes()))
}

pub fn root_install_status_signature(root: &str, entry: &str, size: f64, mtime: f64, font_json: &str) -> Option<String> {
    let source: Value = serde_json::from_str(font_json).ok()?;
    source.as_object()?;
    for key in ["managedInstallPath", "managedRegistryName"] {
        if source.get(key).is_some_and(|value| !value.is_null() && !value.is_string()) { return None; }
    }
    let path = runtime_path(root, entry);
    let id = file_runtime_font_id(&path, size, mtime).ok()?;
    Some(install_status_signature(&id, &path, &file_name_from_path(&path), size, mtime,
        source.get("managedInstallPath").and_then(Value::as_str).unwrap_or(""),
        source.get("managedRegistryName").and_then(Value::as_str).unwrap_or("")))
}

pub fn register_install_status_sql(conn: &Connection) -> rusqlite::Result<()> {
    conn.create_scalar_function("hfm_root_install_status_signature", 5,
        FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
            Ok(root_install_status_signature(&ctx.get::<String>(0)?, &ctx.get::<String>(1)?,
                ctx.get(2)?, ctx.get(3)?, &ctx.get::<String>(4)?))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn install_authority_signature_matches_typescript_vectors() {
        let vectors: Value = serde_json::from_str(include_str!("../../../../build/diagnostics/fixtures/install-status-signature.json")).unwrap();
        for row in vectors.as_array().unwrap() {
            let item = &row["item"];
            assert_eq!(install_status_signature(item["id"].as_str().unwrap(), item["path"].as_str().unwrap(),
                item["fileName"].as_str().unwrap(), item["fileSize"].as_f64().unwrap(), item["modifiedAt"].as_f64().unwrap(),
                item["managedInstallPath"].as_str().unwrap_or(""), item["managedRegistryName"].as_str().unwrap_or("")), row["expected"].as_str().unwrap());
        }
    }
    #[test]
    fn install_authority_root_join_uses_runtime_basename_and_exact_managed_fields() {
        let conn = Connection::open_in_memory().unwrap();
        crate::merged_index::snapshot::register_shared_font_id(&conn).unwrap();
        conn.execute_batch("CREATE TABLE entries(relative_path TEXT,file_size INTEGER,modified_at REAL,font_json TEXT); CREATE TABLE install_status(font_id TEXT,signature TEXT,installed INTEGER,by_type TEXT)").unwrap();
        let root = r"C:\authority";
        let source = serde_json::json!({"fileName":"historical-display.ttf","managedInstallPath":r"C:\managed\a.ttf","managedRegistryName":"Exact Registry"});
        let expected = root_install_status_signature(root, "a.ttf", 1.0, 100.5, &source.to_string()).unwrap();
        assert!(root_install_status_signature(root, "a.ttf", 1.0, 100.5, r#"{"managedInstallPath":42}"#).is_none());
        assert!(root_install_status_signature(root, "a.ttf", 1.0, 100.5, r#"{"managedRegistryName":{}}"#).is_none());
        let id = file_runtime_font_id(r"C:\authority\a.ttf", 1.0, 100.5).unwrap();
        conn.execute("INSERT INTO entries VALUES ('a.ttf',1,100.5,?)", [&source.to_string()]).unwrap();
        conn.execute("INSERT INTO install_status VALUES (?,?,1,'managed')", rusqlite::params![id, expected]).unwrap();
        let sql = "SELECT COUNT(*) FROM entries LEFT JOIN install_status ON install_status.font_id=hfm_file_font_id(?1,entries.relative_path,entries.file_size,entries.modified_at) AND install_status.signature=hfm_root_install_status_signature(?1,entries.relative_path,entries.file_size,entries.modified_at,entries.font_json) WHERE install_status.installed IS NOT NULL";
        assert_eq!(conn.query_row(sql, [root], |row| row.get::<_, i64>(0)).unwrap(), 1);
        conn.execute("UPDATE install_status SET signature='content-v1:stale'", []).unwrap();
        assert_eq!(conn.query_row(sql, [root], |row| row.get::<_, i64>(0)).unwrap(), 0);
        conn.execute("UPDATE install_status SET signature=?", [&expected]).unwrap();
        let changed = serde_json::json!({"managedInstallPath":r"c:\managed\a.ttf","managedRegistryName":"Exact Registry"});
        conn.execute("UPDATE entries SET font_json=?", [&changed.to_string()]).unwrap();
        assert_eq!(conn.query_row(sql, [root], |row| row.get::<_, i64>(0)).unwrap(), 0, "managed field spelling was silently normalized away");
    }

}
