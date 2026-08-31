use rusqlite::Row;
use serde_json::{json, Map, Value};

use super::path_utils::{file_name_from_path, runtime_path, shared_font_id};

#[derive(Clone, Debug)]
pub struct MergedRow {
    root_path: String,
    relative_path: String,
    file_size: f64,
    modified_at: f64,
    created_at: Option<f64>,
    status: String,
    font_json: String,
    installed: Option<i64>,
    installed_by: Option<String>,
    matches_json: Option<String>,
}

impl MergedRow {
    pub fn from_row(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            root_path: row.get("root_path")?,
            relative_path: row.get("relative_path")?,
            file_size: row
                .get::<_, i64>("file_size")
                .map(|value| value as f64)
                .or_else(|_| row.get("file_size"))?,
            modified_at: row.get("modified_at")?,
            created_at: row.get("created_at")?,
            status: row.get("status")?,
            font_json: row.get("font_json")?,
            installed: row.get("installed")?,
            installed_by: row.get("installed_by")?,
            matches_json: row.get("matches_json")?,
        })
    }
}

fn bool_from_json(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0) != 0,
        Some(Value::String(text)) => text == "true" || text == "1",
        _ => false,
    }
}

pub fn font_from_merged_row(row: &MergedRow) -> Option<Value> {
    let Value::Object(source) = serde_json::from_str::<Value>(&row.font_json).ok()? else {
        return None;
    };
    if row.status != "ok" {
        return None;
    }

    let file_path = runtime_path(&row.root_path, &row.relative_path);
    let size = row.file_size;
    let modified_at = row.modified_at;
    let created_at = row.created_at.unwrap_or(modified_at);
    let installed_by = row.installed_by.clone().unwrap_or_else(|| "none".to_string());
    let source_id = source
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let source_path = source
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let cache_identity = if !row.relative_path.is_empty() {
        row.relative_path.clone()
    } else if !source_path.is_empty() {
        source_path
    } else {
        file_path.clone()
    };

    let mut font: Map<String, Value> = source;
    font.insert("id".to_string(), Value::String(shared_font_id(&cache_identity, size, modified_at)));
    font.insert("sourceId".to_string(), Value::String(source_id));
    font.insert("path".to_string(), Value::String(file_path.clone()));
    font.insert("fileName".to_string(), Value::String(file_name_from_path(&file_path)));
    font.insert("fileSize".to_string(), json!(size));
    font.insert("modifiedAt".to_string(), json!(modified_at));
    font.insert("createdAt".to_string(), json!(created_at));
    font.insert("installStatusKnown".to_string(), Value::Bool(false));
    let source_active = bool_from_json(font.get("active"));
    font.insert(
        "active".to_string(),
        Value::Bool(source_active || installed_by == "managed" || installed_by == "both"),
    );
    if !font.contains_key("activeSince") {
        font.insert("activeSince".to_string(), Value::Null);
    }

    if let Some(installed) = row.installed {
        font.insert("installStatusKnown".to_string(), Value::Bool(true));
        font.insert("systemInstalled".to_string(), Value::Bool(installed != 0 && installed_by != "managed"));
        let matches = row
            .matches_json
            .as_deref()
            .and_then(|text| serde_json::from_str::<Value>(text).ok())
            .unwrap_or_else(|| Value::Array(Vec::new()));
        font.insert("systemInstallMatches".to_string(), matches);
    }

    Some(Value::Object(font))
}
