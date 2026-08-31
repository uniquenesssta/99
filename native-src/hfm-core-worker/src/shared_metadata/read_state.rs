use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::Connection;
use serde_json::Value;

use super::signature::shared_metadata_signature_for_conn;
use super::types::{
    SharedMetadataCommandConfig,
    SharedMetadataKnownTagsPayload,
    SharedMetadataKnownTagsResult,
    SharedMetadataKnownTagsRootResult,
    SharedMetadataOverlayMatchedEntry,
    SharedMetadataOverlayReadPayload,
    SharedMetadataOverlayReadResult,
    SharedMetadataTimings,
};

#[derive(Clone, Debug)]
struct OverlayState {
    tag_names: Vec<String>,
    favorite: bool,
    delete_protected: bool,
}

#[derive(Clone, Debug, Default)]
struct OverlayMaps {
    by_font_id: BTreeMap<String, OverlayState>,
    by_relative_path: BTreeMap<String, OverlayState>,
    by_path_key: BTreeMap<String, OverlayState>,
    rows: usize,
}

pub fn read_shared_metadata_known_tags(config: &SharedMetadataCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: SharedMetadataKnownTagsPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let result = read_known_tags(&payload, started_at)?;
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn read_shared_metadata_overlay(config: &SharedMetadataCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: SharedMetadataOverlayReadPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let result = read_overlay_matches(&payload, started_at)?;
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn read_known_tags(payload: &SharedMetadataKnownTagsPayload, started_at: Instant) -> Result<SharedMetadataKnownTagsResult, String> {
    let mut known_tags = BTreeSet::<String>::new();
    let mut roots = Vec::<SharedMetadataKnownTagsRootResult>::new();
    let mut total_rows = 0usize;

    for root in &payload.roots {
        let db_path = root.db_path.trim();
        let root_path = root.root_path.trim();
        if db_path.is_empty() || !Path::new(db_path).exists() {
            roots.push(SharedMetadataKnownTagsRootResult {
                root_path: root_path.to_string(),
                db_path: db_path.to_string(),
                signature: "metadata:none".to_string(),
                known_tags: Vec::new(),
                rows: 0,
            });
            continue;
        }

        let conn = match Connection::open(db_path) {
            Ok(conn) => conn,
            Err(_) => {
                roots.push(SharedMetadataKnownTagsRootResult {
                    root_path: root_path.to_string(),
                    db_path: db_path.to_string(),
                    signature: "metadata:error".to_string(),
                    known_tags: Vec::new(),
                    rows: 0,
                });
                continue;
            }
        };

        let (root_tags, rows) = read_root_known_tags(&conn).map_err(|error| error.to_string())?;
        let signature = shared_metadata_signature_for_conn(&conn).unwrap_or_else(|_| "metadata:none".to_string());
        total_rows += rows;
        for tag in &root_tags {
            known_tags.insert(tag.clone());
        }
        roots.push(SharedMetadataKnownTagsRootResult {
            root_path: root_path.to_string(),
            db_path: db_path.to_string(),
            signature,
            known_tags: root_tags,
            rows,
        });
    }

    Ok(SharedMetadataKnownTagsResult {
        ok: true,
        known_tags: known_tags.into_iter().collect(),
        roots,
        timings: SharedMetadataTimings { elapsed: started_at.elapsed().as_millis(), rows: total_rows },
        worker_mode: "rust-shared-metadata-known-tags".to_string(),
    })
}

fn read_overlay_matches(payload: &SharedMetadataOverlayReadPayload, started_at: Instant) -> Result<SharedMetadataOverlayReadResult, String> {
    let db_path = payload.db_path.trim();
    let root_path = payload.root_path.trim();
    if db_path.is_empty() || !Path::new(db_path).exists() {
        return Ok(SharedMetadataOverlayReadResult {
            ok: true,
            root_path: root_path.to_string(),
            db_path: db_path.to_string(),
            signature: "metadata:none".to_string(),
            matched: Vec::new(),
            rows: 0,
            requested: payload.entries.len(),
            timings: SharedMetadataTimings { elapsed: started_at.elapsed().as_millis(), rows: 0 },
            worker_mode: "rust-shared-metadata-overlay-read".to_string(),
        });
    }

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    let overlay = read_overlay_maps(&conn).map_err(|error| error.to_string())?;
    let signature = shared_metadata_signature_for_conn(&conn).unwrap_or_else(|_| "metadata:none".to_string());
    let mut matched = Vec::<SharedMetadataOverlayMatchedEntry>::new();

    for entry in &payload.entries {
        let key = entry.key.trim();
        if key.is_empty() {
            continue;
        }
        let relative_path = normalize_relative_path(&entry.relative_path);
        let font_id = entry.font_id.trim();
        let path_key = normalize_path_key(&entry.path_key);
        let found = overlay
            .by_relative_path
            .get(&relative_path)
            .map(|state| (state, "relativePath"))
            .or_else(|| overlay.by_font_id.get(font_id).map(|state| (state, "fontId")))
            .or_else(|| overlay.by_path_key.get(&path_key).map(|state| (state, "pathKey")));
        let Some((state, matched_by)) = found else {
            continue;
        };
        matched.push(SharedMetadataOverlayMatchedEntry {
            key: key.to_string(),
            tag_names: state.tag_names.clone(),
            favorite: state.favorite,
            delete_protected: state.delete_protected,
            matched_by: matched_by.to_string(),
        });
    }

    Ok(SharedMetadataOverlayReadResult {
        ok: true,
        root_path: root_path.to_string(),
        db_path: db_path.to_string(),
        signature,
        matched,
        rows: overlay.rows,
        requested: payload.entries.len(),
        timings: SharedMetadataTimings { elapsed: started_at.elapsed().as_millis(), rows: overlay.rows },
        worker_mode: "rust-shared-metadata-overlay-read".to_string(),
    })
}

fn read_root_known_tags(conn: &Connection) -> rusqlite::Result<(Vec<String>, usize)> {
    if !table_exists(conn, "font_metadata")? {
        return Ok((Vec::new(), 0));
    }
    let mut stmt = conn.prepare("SELECT tag_names_json FROM font_metadata")?;
    let rows = stmt.query_map([], |row| row.get::<_, Option<String>>(0))?;
    let mut tags = BTreeSet::<String>::new();
    let mut count = 0usize;
    for row in rows {
        count += 1;
        let tag_json = row?.unwrap_or_default();
        for tag in parse_tag_names_json(&tag_json) {
            tags.insert(tag);
        }
    }
    Ok((tags.into_iter().collect(), count))
}

fn read_overlay_maps(conn: &Connection) -> rusqlite::Result<OverlayMaps> {
    if !table_exists(conn, "font_metadata")? {
        return Ok(OverlayMaps::default());
    }
    let mut stmt = conn.prepare("SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected FROM font_metadata")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, Option<String>>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<i64>>(5)?,
        ))
    })?;
    let mut overlay = OverlayMaps::default();
    for row in rows {
        overlay.rows += 1;
        let row = row?;
        let state = OverlayState {
            tag_names: parse_tag_names_json(&row.3.unwrap_or_default()),
            favorite: row.4.unwrap_or(0) != 0,
            delete_protected: row.5.unwrap_or(0) != 0,
        };
        if let Some(font_id) = row.0.map(|value| value.trim().to_string()).filter(|value| !value.is_empty()) {
            overlay.by_font_id.insert(font_id, state.clone());
        }
        if let Some(relative_path) = row.1.map(|value| normalize_relative_path(&value)).filter(|value| !value.is_empty()) {
            overlay.by_relative_path.insert(relative_path, state.clone());
        }
        if let Some(path_key) = row.2.map(|value| normalize_path_key(&value)).filter(|value| !value.is_empty()) {
            overlay.by_path_key.insert(path_key, state);
        }
    }
    Ok(overlay)
}

fn parse_tag_names_json(value: &str) -> Vec<String> {
    let Ok(parsed) = serde_json::from_str::<Value>(value) else {
        return Vec::new();
    };
    let Some(items) = parsed.as_array() else {
        return Vec::new();
    };
    let mut tags = BTreeSet::<String>::new();
    for item in items {
        let Some(text) = item.as_str() else {
            continue;
        };
        let tag = text.trim();
        if !tag.is_empty() {
            tags.insert(tag.to_string());
        }
    }
    tags.into_iter().collect()
}

fn normalize_relative_path(value: &str) -> String {
    value.replace('\\', "/")
}

fn normalize_path_key(value: &str) -> String {
    value.replace('\\', "/").to_lowercase()
}

fn table_exists(conn: &Connection, table_name: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        [table_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}
