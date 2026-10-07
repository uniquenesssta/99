use std::fs::{self, Metadata};
use std::time::UNIX_EPOCH;


use super::types::DirectorySignature;

fn is_ignored_internal_directory_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower == ".hfm-cache"
        || lower == ".hfm-preview-cache"
        || lower == ".hfm"
        || lower == ".hanfontmanager"
}

pub fn metadata_modified_ms(metadata: &Metadata) -> f64 {
    metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn file_cache_signature(relative_path: &str, size: u64, modified_ms: f64) -> String {
    format!("{}|{}|{}", relative_path.to_ascii_lowercase(), size, modified_ms.round() as i64)
}

pub fn compute_directory_signature(path: &std::path::Path) -> Option<DirectorySignature> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_dir() {
        return None;
    }

    let mut file_count: i64 = 0;
    let mut dir_count: i64 = 0;
    let entries = fs::read_dir(path).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let file_type = match entry.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        if file_type.is_dir() {
            if name == "node_modules" || name.starts_with('.') || is_ignored_internal_directory_name(&name) {
                continue;
            }
            dir_count += 1;
        } else if file_type.is_file() {
            file_count += 1;
        }
    }

    Some(DirectorySignature {
        modified_at: metadata_modified_ms(&metadata),
        file_count,
        dir_count,
    })
}

pub fn directory_signature_matches(a: &DirectorySignature, b: &DirectorySignature) -> bool {
    a.modified_at.round() as i64 == b.modified_at.round() as i64
        && a.file_count == b.file_count
        && a.dir_count == b.dir_count
}
