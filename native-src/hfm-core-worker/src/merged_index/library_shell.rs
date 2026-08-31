use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::Value;

#[derive(Clone, Debug, Default)]
pub struct LibraryShell {
    pub folders: Vec<String>,
    pub folder_node_ids: Vec<String>,
    pub collection_ids: Vec<String>,
    pub shared_tags: Vec<String>,
    pub local_tags: Vec<String>,
}

fn parse_json(value: Option<String>, fallback: Value) -> Value {
    value
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .unwrap_or(fallback)
}

fn read_string_rows(conn: &Connection, sql: &str) -> Vec<String> {
    let Ok(mut stmt) = conn.prepare(sql) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };
    rows.filter_map(Result::ok).collect()
}

pub fn read_library_shell(conn: &Connection) -> LibraryShell {
    let mut state = BTreeMap::<String, String>::new();
    if let Ok(mut stmt) = conn.prepare("SELECT key, value FROM local_db.app_state") {
        if let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))) {
            for (key, value) in rows.filter_map(Result::ok) {
                state.insert(key, value);
            }
        }
    }

    let folders = read_string_rows(conn, "SELECT path FROM local_db.folders ORDER BY sort_order");
    let shared_tags = read_string_rows(conn, "SELECT name FROM local_db.tags ORDER BY sort_order");
    let folder_node_ids = read_string_rows(conn, "SELECT json FROM local_db.folder_nodes ORDER BY sort_order")
        .into_iter()
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .filter_map(|value| value.get("id").and_then(Value::as_str).map(|text| text.to_string()))
        .collect();
    let collection_ids = read_string_rows(conn, "SELECT json FROM local_db.collections ORDER BY sort_order")
        .into_iter()
        .filter_map(|text| serde_json::from_str::<Value>(&text).ok())
        .filter_map(|value| value.get("id").and_then(Value::as_str).map(|text| text.to_string()))
        .collect();
    let local_tags = match parse_json(state.get("localTags").cloned(), Value::Array(Vec::new())) {
        Value::Array(items) => items
            .into_iter()
            .filter_map(|value| value.as_str().map(|text| text.to_string()))
            .collect(),
        _ => Vec::new(),
    };

    LibraryShell {
        folders,
        folder_node_ids,
        collection_ids,
        shared_tags,
        local_tags,
    }
}
