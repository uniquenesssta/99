use std::fs;
use std::path::{Path, PathBuf};

use super::normalize::path_file_name;
use super::types::SystemInstalledFontRecord;

fn has_font_extension(path: &Path, extensions: &[String]) -> bool {
    let Some(ext) = path.extension().map(|value| value.to_string_lossy().to_ascii_lowercase()) else {
        return false;
    };
    extensions.iter().any(|candidate| candidate == &ext)
}

pub fn read_folder_installed_fonts(
    windows_fonts_dir: &str,
    current_user_fonts_dir: &str,
    extensions: &[String],
) -> Vec<SystemInstalledFontRecord> {
    let folders = [
        (windows_fonts_dir, "WindowsFontsFolder"),
        (current_user_fonts_dir, "HKCU"),
    ];
    let mut items = Vec::new();

    for (dir, source) in folders {
        if dir.trim().is_empty() {
            continue;
        }
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !has_font_extension(&path, extensions) {
                continue;
            }
            let full = PathBuf::from(&path).to_string_lossy().to_string();
            let file_name = path_file_name(&full);
            let registry_name = file_name.clone().unwrap_or_else(|| full.clone());
            items.push(SystemInstalledFontRecord {
                source: source.to_string(),
                registry_name,
                value: full.clone(),
                path: Some(full),
                file_name,
                name_candidates: Vec::new(),
            });
        }
    }

    items
}
