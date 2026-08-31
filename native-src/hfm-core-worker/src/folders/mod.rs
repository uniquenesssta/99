use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime};

use serde::{Deserialize, Serialize};

use crate::merged_index::path_utils::normalize_native_path_text;

#[derive(Clone, Debug)]
pub struct PhysicalFolderTreeConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhysicalFolderTreePayload {
    #[serde(default)]
    folders: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FolderNode {
    id: String,
    name: String,
    parent_id: String,
    root_path: String,
    created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhysicalFolderTreeResult {
    ok: bool,
    folders: Vec<String>,
    nodes: Vec<FolderNode>,
    errors: Vec<String>,
    elapsed_ms: u128,
    worker_mode: &'static str,
}

pub fn list_physical_folder_tree(config: &PhysicalFolderTreeConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let raw = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: PhysicalFolderTreePayload = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let mut folders = Vec::new();
    let mut nodes = Vec::new();
    let mut errors = Vec::new();
    let mut seen_roots = std::collections::BTreeSet::new();
    let mut seen_nodes = std::collections::BTreeSet::new();

    for raw_folder in payload.folders {
        if raw_folder.trim().is_empty() {
            continue;
        }
        let root = normalize_path(Path::new(&raw_folder));
        let root_key = cache_key(&root);
        if !seen_roots.insert(root_key) {
            continue;
        }
        match fs::metadata(&root) {
            Ok(stat) if stat.is_dir() => {
                let root_text = normalize_native_path_text(&root.to_string_lossy());
                folders.push(root_text.clone());
                walk(&root_text, &root_text, &root, &mut nodes, &mut errors, &mut seen_nodes);
            }
            Ok(_) => errors.push(format!("folder tree root skipped: {} is not directory", root.display())),
            Err(error) => errors.push(format!("folder tree root skipped: {} {}", root.display(), error)),
        }
    }

    let result = PhysicalFolderTreeResult {
        ok: true,
        folders,
        nodes,
        errors,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-physical-folder-tree",
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn walk(
    root_path_text: &str,
    parent_id: &str,
    dir: &Path,
    nodes: &mut Vec<FolderNode>,
    errors: &mut Vec<String>,
    seen: &mut std::collections::BTreeSet<String>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(value) => value,
        Err(error) => {
            errors.push(format!("folder tree read failed: {} {}", dir.display(), error));
            return;
        }
    };

    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else { continue; };
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_internal_directory_name(&name) {
            continue;
        }
        let full = entry.path();
        let key = cache_key(&full);
        if !seen.insert(key) {
            continue;
        }
        let full_text = normalize_native_path_text(&full.to_string_lossy());
        nodes.push(FolderNode {
            id: full_text.clone(),
            name,
            parent_id: parent_id.to_string(),
            root_path: root_path_text.to_string(),
            created_at: created_at_iso(&full),
        });
        walk(root_path_text, &full_text, &full, nodes, errors, seen);
    }
}

fn is_ignored_internal_directory_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".hfm-cache" || lower == ".hfm-preview-cache" || lower == ".hfm" || lower == ".hanfontmanager"
}

fn normalize_path(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn cache_key(path: &Path) -> String {
    path.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}

fn created_at_iso(path: &Path) -> String {
    let time = fs::metadata(path)
        .and_then(|stat| stat.created().or_else(|_| stat.modified()))
        .unwrap_or_else(|_| SystemTime::now());
    system_time_to_iso(time)
}

fn system_time_to_iso(time: SystemTime) -> String {
    let duration = time.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default();
    let total_secs = duration.as_secs() as i64;
    let millis = duration.subsec_millis();
    let days = total_secs.div_euclid(86_400);
    let seconds_of_day = total_secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = seconds_of_day / 3_600;
    let minute = (seconds_of_day % 3_600) / 60;
    let second = seconds_of_day % 60;
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", year, month, day, hour, minute, second, millis)
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year, m, d)
}
