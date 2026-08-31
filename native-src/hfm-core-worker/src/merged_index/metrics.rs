use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::category::infer_font_search_category;
use super::font_row::{font_from_merged_row, MergedRow};
use super::library_shell::{read_library_shell, LibraryShell};
use super::path_utils::normalize_path_for_compare;
use super::snapshot::{local_table_columns, register_shared_font_id, roots_snapshot_usable};
use super::tag_revision::merged_index_tag_revision_metadata;
use super::types::{MergedIndexMetricsQueryConfig, MergedIndexMetricsQueryPayload, MergedIndexMetricsQueryResult};

fn elapsed_ms(started_at: &Instant) -> u128 {
    started_at.elapsed().as_millis()
}

fn elapsed_since(started_at: Instant) -> u128 {
    started_at.elapsed().as_millis()
}

fn sqlite_literal(value: &str) -> String {
    format!("'{}'", value.replace("'", "''"))
}

fn zero_counts(keys: &[&str]) -> BTreeMap<String, i64> {
    keys.iter().map(|key| (key.to_string(), 0)).collect()
}

fn increment(map: &mut BTreeMap<String, i64>, key: &str) {
    *map.entry(key.to_string()).or_insert(0) += 1;
}

fn bool_field(font: &Value, field: &str) -> bool {
    match font.get(field) {
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0) != 0,
        Some(Value::String(text)) => text == "true" || text == "1",
        _ => false,
    }
}

fn string_field(font: &Value, field: &str) -> String {
    font.get(field).and_then(Value::as_str).unwrap_or("").to_string()
}

fn string_array(font: &Value, field: &str) -> Vec<String> {
    match font.get(field) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.trim().to_string()),
                Value::Number(number) => Some(number.to_string()),
                Value::Bool(flag) => Some(flag.to_string()),
                _ => None,
            })
            .filter(|text| !text.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn normalize_font_format(value: &str) -> &'static str {
    let raw = value.to_lowercase();
    if raw == "ttf" || raw.contains("truetype") {
        return "ttf";
    }
    if raw == "otf" || raw.contains("opentype") {
        return "otf";
    }
    if raw == "ttc" {
        return "ttc";
    }
    if raw == "otc" {
        return "otc";
    }
    "unknown"
}

fn font_directory_key_for_metrics(file_path: &str) -> String {
    let clean = normalize_path_for_compare(file_path);
    match clean.rfind('\\') {
        Some(index) => clean[..index].to_string(),
        None => clean,
    }
}

fn font_folder_ancestor_keys_for_metrics(file_path: &str) -> Vec<String> {
    let mut keys = Vec::new();
    let mut current = font_directory_key_for_metrics(file_path);
    while !current.is_empty() {
        keys.push(current.clone());
        let Some(index) = current.rfind('\\') else {
            break;
        };
        if index <= 2 {
            break;
        }
        current = current[..index].to_string();
    }
    keys
}

fn path_matches_prefix(file_path: &str, folder: &str) -> bool {
    let normalized = normalize_path_for_compare(file_path);
    let prefix = normalize_path_for_compare(folder);
    normalized == prefix || normalized.starts_with(&format!("{}\\", prefix))
}

fn prepare_folder_map(shell: &LibraryShell) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for folder in &shell.folders {
        map.insert(normalize_path_for_compare(folder), folder.clone());
    }
    for node_id in &shell.folder_node_ids {
        map.insert(normalize_path_for_compare(node_id), node_id.clone());
    }
    map
}

fn local_tag_counts(conn: &Connection) -> BTreeMap<String, i64> {
    let mut result = BTreeMap::new();
    let columns = local_table_columns(conn, "local_font_tags");
    if !columns.contains("tag_name") || !columns.contains("font_id") {
        return result;
    }
    let sql = if columns.contains("font_path") {
        "SELECT tag_name, COUNT(DISTINCT COALESCE(NULLIF(font_path, ''), font_id)) AS count FROM local_db.local_font_tags GROUP BY tag_name"
    } else {
        "SELECT tag_name, COUNT(DISTINCT font_id) AS count FROM local_db.local_font_tags GROUP BY tag_name"
    };
    if let Ok(mut stmt) = conn.prepare(sql) {
        if let Ok(rows) = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))) {
            for (tag, count) in rows.filter_map(Result::ok) {
                result.insert(tag, count);
            }
        }
    }
    result
}

#[derive(Clone, Debug)]
struct MetricsState {
    total: i64,
    favorite_count: i64,
    installed_count: i64,
    active_count: i64,
    install_status_known_count: i64,
    format_counts: BTreeMap<String, i64>,
    category_counts: BTreeMap<String, i64>,
    script_counts: BTreeMap<String, i64>,
    collection_counts: BTreeMap<String, i64>,
    local_tag_counts: BTreeMap<String, i64>,
    shared_tag_counts: BTreeMap<String, i64>,
    folder_counts: BTreeMap<String, i64>,
}

impl MetricsState {
    fn new(shell: &LibraryShell, local_counts: BTreeMap<String, i64>) -> Self {
        let mut collection_counts = BTreeMap::new();
        for id in &shell.collection_ids {
            collection_counts.insert(id.clone(), 0);
        }
        let mut local_tag_counts = BTreeMap::new();
        for tag in &shell.local_tags {
            local_tag_counts.insert(tag.clone(), 0);
        }
        for (tag, count) in local_counts {
            local_tag_counts.insert(tag, count);
        }
        let mut shared_tag_counts = BTreeMap::new();
        for tag in &shell.shared_tags {
            shared_tag_counts.insert(tag.clone(), 0);
        }
        let mut folder_counts = BTreeMap::new();
        for folder in &shell.folders {
            folder_counts.insert(folder.clone(), 0);
        }
        for id in &shell.folder_node_ids {
            folder_counts.insert(id.clone(), 0);
        }
        Self {
            total: 0,
            favorite_count: 0,
            installed_count: 0,
            active_count: 0,
            install_status_known_count: 0,
            format_counts: zero_counts(&["ttf", "otf", "ttc", "otc", "unknown"]),
            category_counts: zero_counts(&["all", "serif", "slabSerif", "sansSerif", "script", "monospace", "handwriting", "hei", "art"]),
            script_counts: BTreeMap::new(),
            collection_counts,
            local_tag_counts,
            shared_tag_counts,
            folder_counts,
        }
    }

    fn add_font(&mut self, font: &Value, payload_roots: &[String], folder_id_by_key: &BTreeMap<String, String>) {
        self.total += 1;
        increment(&mut self.format_counts, normalize_font_format(&string_field(font, "format")));
        increment(&mut self.category_counts, infer_font_search_category(font));
        if bool_field(font, "favorite") {
            self.favorite_count += 1;
        }
        if bool_field(font, "active") {
            self.active_count += 1;
        }
        if bool_field(font, "installStatusKnown") {
            self.install_status_known_count += 1;
            if bool_field(font, "systemInstalled") {
                self.installed_count += 1;
            }
        }
        for script in string_array(font, "scripts") {
            increment(&mut self.script_counts, &script);
        }
        for collection_id in string_array(font, "collectionIds") {
            increment(&mut self.collection_counts, &collection_id);
        }
        for tag_name in string_array(font, "tagNames") {
            increment(&mut self.shared_tag_counts, &tag_name);
        }
        self.add_folder_counts(font, payload_roots, folder_id_by_key);
    }

    fn add_folder_counts(&mut self, font: &Value, payload_roots: &[String], folder_id_by_key: &BTreeMap<String, String>) {
        let path = string_field(font, "path");
        let mut counted = BTreeSet::new();
        for key in font_folder_ancestor_keys_for_metrics(&path) {
            let Some(folder_id) = folder_id_by_key.get(&key) else {
                continue;
            };
            if counted.insert(folder_id.clone()) {
                increment(&mut self.folder_counts, folder_id);
            }
        }
        for folder in payload_roots {
            if counted.contains(folder) || !path_matches_prefix(&path, folder) {
                continue;
            }
            counted.insert(folder.clone());
            increment(&mut self.folder_counts, folder);
        }
    }

    fn to_json(self, timings: BTreeMap<&str, u128>, tag_revision: Value, started_at: &Instant) -> Value {
        let missing = (self.total - self.install_status_known_count).max(0);
        let not_installed = (self.install_status_known_count - self.installed_count).max(0);
        let mut tag_counts = self.shared_tag_counts.clone();
        for (key, value) in &self.local_tag_counts {
            tag_counts.insert(key.clone(), *value);
        }
        let mut category_counts = self.category_counts;
        category_counts.insert("all".to_string(), self.total);
        json!({
            "ok": true,
            "total": self.total,
            "favoriteCount": self.favorite_count,
            "installedCount": self.installed_count,
            "notInstalledCount": not_installed,
            "installStatusKnownCount": self.install_status_known_count,
            "installStatusMissingCount": missing,
            "installStatusReady": missing == 0,
            "activeCount": self.active_count,
            "systemDefaultCount": 0,
            "formatCounts": self.format_counts,
            "categoryCounts": category_counts,
            "scriptCounts": self.script_counts,
            "collectionCounts": self.collection_counts,
            "tagCounts": tag_counts,
            "localTagCounts": self.local_tag_counts,
            "sharedTagCounts": self.shared_tag_counts,
            "folderCounts": self.folder_counts,
            "elapsedMs": elapsed_ms(started_at),
            "workerMode": "rust-merged-index-metrics",
            "tagRevision": tag_revision,
            "timings": timings,
        })
    }
}

pub fn query_merged_index_metrics(config: &MergedIndexMetricsQueryConfig) -> Result<MergedIndexMetricsQueryResult, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: MergedIndexMetricsQueryPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    if !Path::new(&payload.merged_index_db_path).exists() {
        return Err("merged index database does not exist".to_string());
    }

    let open_started_at = Instant::now();
    let conn = Connection::open_with_flags(
        &payload.merged_index_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|error| error.to_string())?;
    let mut timings: BTreeMap<&str, u128> = BTreeMap::new();
    timings.insert("open", elapsed_since(open_started_at));

    register_shared_font_id(&conn).map_err(|error| error.to_string())?;
    if !roots_snapshot_usable(&conn, &payload.roots, payload.schema_version).map_err(|error| error.to_string())? {
        return Err("merged index snapshot is not usable".to_string());
    }

    let attach_started_at = Instant::now();
    conn.execute_batch(&format!("ATTACH DATABASE {} AS local_db", sqlite_literal(&payload.library_db_path)))
        .map_err(|error| error.to_string())?;
    timings.insert("attachLocal", elapsed_since(attach_started_at));
    let _ = conn.execute_batch("PRAGMA query_only = true");

    let shell_started_at = Instant::now();
    let shell = read_library_shell(&conn);
    timings.insert("shell", elapsed_since(shell_started_at));
    let folder_id_by_key = prepare_folder_map(&shell);
    let local_counts = local_tag_counts(&conn);
    let mut state = MetricsState::new(&shell, local_counts);

    let select_started_at = Instant::now();
    let mut stmt = conn
        .prepare("SELECT root_path, relative_path, cache_key, file_size, modified_at, created_at, status, font_json, installed, installed_by, matches_json FROM entries WHERE COALESCE(is_deleted, 0) = 0 AND status = 'ok' AND font_json IS NOT NULL")
        .map_err(|error| error.to_string())?;
    let rows = stmt
        .query_map([], MergedRow::from_row)
        .map_err(|error| error.to_string())?;
    let merged_rows = rows.filter_map(Result::ok).collect::<Vec<_>>();
    timings.insert("select", elapsed_since(select_started_at));

    let parse_started_at = Instant::now();
    for row in &merged_rows {
        if let Some(font) = font_from_merged_row(row) {
            state.add_font(&font, &payload.roots, &folder_id_by_key);
        }
    }
    timings.insert("parse", elapsed_since(parse_started_at));

    let tag_revision = merged_index_tag_revision_metadata(&conn, &payload.library_db_path, &payload.tag_revision);
    let json = state.to_json(timings, tag_revision, &started_at);
    Ok(MergedIndexMetricsQueryResult {
        json: serde_json::to_string(&json).map_err(|error| error.to_string())?,
    })
}
