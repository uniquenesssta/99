use std::collections::BTreeMap;
use std::path::PathBuf;

use rusqlite::{Connection, OptionalExtension};
use serde_json::{Map, Value};

use super::path_utils::runtime_path;

#[derive(Clone, Debug)]
struct SharedMetadataState {
    tag_names: Vec<String>,
    favorite: bool,
    delete_protected: bool,
}

#[derive(Clone, Debug, Default)]
pub struct SharedMetadataOverlay {
    by_font_id: BTreeMap<String, SharedMetadataState>,
    by_relative_path: BTreeMap<String, SharedMetadataState>,
    by_path_key: BTreeMap<String, SharedMetadataState>,
}

fn shared_metadata_db_path(root_path: &str) -> PathBuf {
    let mut path = PathBuf::from(root_path);
    path.push(".hfm-cache");
    path.push("database");
    path.push("shared-metadata.sqlite");
    path
}

fn clean_tag_names(input: Vec<String>) -> Vec<String> {
    let mut tags = input
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    tags.sort();
    tags.dedup();
    tags
}

fn parse_tag_names(value: Option<String>) -> Vec<String> {
    let Some(text) = value else {
        return Vec::new();
    };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(&text) else {
        return Vec::new();
    };
    clean_tag_names(
        items
            .into_iter()
            .filter_map(|item| item.as_str().map(|text| text.to_string()))
            .collect(),
    )
}

fn normalize_relative_path(value: &str) -> String {
    value.replace('\\', "/")
}

fn normalize_path_key(value: &str) -> String {
    value.replace('\\', "/").to_lowercase()
}

impl SharedMetadataOverlay {
    pub fn load_for_root(root_path: &str) -> Self {
        let db_path = shared_metadata_db_path(root_path);
        if !db_path.exists() {
            return Self::default();
        }
        let Ok(conn) = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY) else {
            return Self::default();
        };
        let table_exists = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'font_metadata' LIMIT 1",
                [],
                |_| Ok(()),
            )
            .optional()
            .ok()
            .flatten()
            .is_some();
        if !table_exists {
            return Self::default();
        }

        let Ok(mut stmt) = conn.prepare("SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected FROM font_metadata") else {
            return Self::default();
        };
        let Ok(rows) = stmt.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<i64>>(4)?,
                row.get::<_, Option<i64>>(5)?,
            ))
        }) else {
            return Self::default();
        };

        let mut overlay = Self::default();
        for row in rows.filter_map(Result::ok) {
            let state = SharedMetadataState {
                tag_names: parse_tag_names(row.3),
                favorite: row.4.unwrap_or(0) != 0,
                delete_protected: row.5.unwrap_or(0) != 0,
            };
            if let Some(font_id) = row.0.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
                overlay.by_font_id.insert(font_id, state.clone());
            }
            if let Some(relative_path) = row.1.map(|value| normalize_relative_path(&value)).filter(|value| !value.is_empty()) {
                overlay.by_relative_path.insert(relative_path, state.clone());
            }
            if let Some(path_key) = row.2.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
                overlay.by_path_key.insert(path_key, state);
            }
        }
        overlay
    }

    pub fn is_empty(&self) -> bool {
        self.by_font_id.is_empty() && self.by_relative_path.is_empty() && self.by_path_key.is_empty()
    }

    pub fn apply_to_font_json(&self, root_path: &str, relative_path: &str, font_json: &str) -> String {
        if self.is_empty() {
            return font_json.to_string();
        }
        let Ok(Value::Object(mut font)) = serde_json::from_str::<Value>(font_json) else {
            return font_json.to_string();
        };
        let font_id = font.get("id").and_then(Value::as_str).unwrap_or("");
        let source_path = font.get("path").and_then(Value::as_str).unwrap_or("");
        let fallback_path = runtime_path(root_path, relative_path);
        let path_key_source = if source_path.is_empty() { fallback_path.as_str() } else { source_path };
        let state = self
            .by_relative_path
            .get(&normalize_relative_path(relative_path))
            .or_else(|| self.by_font_id.get(font_id))
            .or_else(|| self.by_path_key.get(&normalize_path_key(path_key_source)));
        let Some(state) = state else {
            return font_json.to_string();
        };
        apply_state_to_font(&mut font, state);
        serde_json::to_string(&Value::Object(font)).unwrap_or_else(|_| font_json.to_string())
    }
}

fn apply_state_to_font(font: &mut Map<String, Value>, state: &SharedMetadataState) {
    font.insert(
        "tagNames".to_string(),
        Value::Array(state.tag_names.iter().cloned().map(Value::String).collect()),
    );
    font.insert("favorite".to_string(), Value::Bool(state.favorite));
    font.insert("deleteProtected".to_string(), Value::Bool(state.delete_protected));
}
