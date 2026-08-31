use std::collections::{BTreeMap, HashMap};

use rusqlite::types::Value as SqlValue;
use rusqlite::Connection;
use serde_json::Value;

use super::path_utils::normalize_path_for_compare;
use super::snapshot::local_table_columns;
use super::sqlite_params::query_string_pairs;

fn normalize_local_tag_font_path(value: &str) -> String {
    normalize_path_for_compare(value.trim())
}

fn text_field(value: &Value, field: &str) -> String {
    value.get(field).and_then(Value::as_str).unwrap_or("").to_string()
}

pub fn hydrate_local_tags(conn: &Connection, items: Vec<Value>) -> Vec<Value> {
    if items.is_empty() {
        return items;
    }
    let columns = local_table_columns(conn, "local_font_tags");
    if !columns.contains("font_id") || !columns.contains("tag_name") {
        return items
            .into_iter()
            .map(|mut item| {
                if let Some(object) = item.as_object_mut() {
                    object.entry("localTagNames".to_string()).or_insert_with(|| Value::Array(Vec::new()));
                }
                item
            })
            .collect();
    }

    let mut alias_to_runtime_id: HashMap<String, String> = HashMap::new();
    let mut path_to_runtime_id: HashMap<String, String> = HashMap::new();
    let mut ids: Vec<String> = Vec::new();
    let mut paths: Vec<String> = Vec::new();

    for item in &items {
        let runtime_id = text_field(item, "id");
        if runtime_id.is_empty() {
            continue;
        }
        for raw in [text_field(item, "id"), text_field(item, "sourceId")] {
            let id = raw.trim().to_string();
            if id.is_empty() {
                continue;
            }
            if !alias_to_runtime_id.contains_key(&id) {
                ids.push(id.clone());
            }
            alias_to_runtime_id.insert(id, runtime_id.clone());
        }
        let font_path = normalize_local_tag_font_path(&text_field(item, "path"));
        if !font_path.is_empty() {
            if !path_to_runtime_id.contains_key(&font_path) {
                paths.push(font_path.clone());
            }
            path_to_runtime_id.insert(font_path, runtime_id);
        }
    }

    let mut tag_map: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut add_tag = |runtime_id: String, tag_name: String| {
        if runtime_id.is_empty() || tag_name.is_empty() {
            return;
        }
        let tags = tag_map.entry(runtime_id).or_default();
        if !tags.iter().any(|entry| entry == &tag_name) {
            tags.push(tag_name);
        }
    };

    for chunk in ids.chunks(500) {
        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!("SELECT font_id, tag_name FROM local_db.local_font_tags WHERE font_id IN ({}) ORDER BY tag_name", placeholders);
        let params = chunk.iter().map(|value| SqlValue::Text(value.clone())).collect::<Vec<_>>();
        if let Ok(rows) = query_string_pairs(conn, &sql, params) {
            for (font_id, tag_name) in rows {
                let runtime_id = alias_to_runtime_id.get(&font_id).cloned().unwrap_or(font_id);
                add_tag(runtime_id, tag_name);
            }
        }
    }

    if columns.contains("font_path") {
        for chunk in paths.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("SELECT font_path, tag_name FROM local_db.local_font_tags WHERE font_path IN ({}) ORDER BY tag_name", placeholders);
            let params = chunk.iter().map(|value| SqlValue::Text(value.clone())).collect::<Vec<_>>();
            if let Ok(rows) = query_string_pairs(conn, &sql, params) {
                for (font_path, tag_name) in rows {
                    let runtime_id = path_to_runtime_id.get(&font_path).cloned().unwrap_or_default();
                    add_tag(runtime_id, tag_name);
                }
            }
        }
    }

    items
        .into_iter()
        .map(|mut item| {
            if let Some(object) = item.as_object_mut() {
                let id = object.get("id").and_then(Value::as_str).unwrap_or("");
                let tags = tag_map
                    .get(id)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(Value::String)
                    .collect::<Vec<_>>();
                object.insert("localTagNames".to_string(), Value::Array(tags));
            }
            item
        })
        .collect()
}
