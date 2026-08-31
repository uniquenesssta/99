use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::normalize::{looks_like_windows_absolute_path, path_file_name};
use super::types::SystemInstalledFontRecord;

const FONT_REGISTRY_ROOTS: [(&str, &str); 2] = [
    ("HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts", "HKCU"),
    ("HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts", "HKLM"),
];

fn parse_registry_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.to_ascii_uppercase().starts_with("HKEY_") {
        return None;
    }

    for (offset, _) in trimmed.match_indices("REG_") {
        if offset > 0 && !trimmed[..offset].chars().last().unwrap_or(' ').is_whitespace() {
            continue;
        }
        let registry_name = trimmed[..offset].trim().to_string();
        if registry_name.is_empty() {
            return None;
        }
        let after_type = &trimmed[offset..];
        let type_end = after_type.find(char::is_whitespace)?;
        let value = after_type[type_end..].trim().to_string();
        if value.is_empty() {
            return None;
        }
        return Some((registry_name, value));
    }
    None
}

fn possible_installed_font_path(raw_value: &str, windows_fonts_dir: &str) -> String {
    let value = raw_value.trim().trim_matches('"').to_string();
    if looks_like_windows_absolute_path(&value) {
        return value;
    }

    if value.contains('\\') || value.contains('/') {
        let windir = env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".to_string());
        return PathBuf::from(windir).join(value).to_string_lossy().to_string();
    }

    PathBuf::from(windows_fonts_dir).join(value).to_string_lossy().to_string()
}

pub fn read_registry_installed_fonts(windows_fonts_dir: &str) -> Vec<SystemInstalledFontRecord> {
    if env::consts::OS != "windows" {
        return Vec::new();
    }

    let mut items = Vec::new();
    for (root, source) in FONT_REGISTRY_ROOTS {
        let output = match Command::new("reg").args(["query", root]).output() {
            Ok(output) => output,
            Err(_) => continue,
        };
        if !output.status.success() {
            continue;
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        for line in stdout.lines() {
            let Some((registry_name, value)) = parse_registry_line(line) else { continue };
            let path = possible_installed_font_path(&value, windows_fonts_dir);
            if !Path::new(&path).exists() {
                continue;
            }
            items.push(SystemInstalledFontRecord {
                source: source.to_string(),
                registry_name,
                value,
                file_name: path_file_name(&path),
                path: Some(path),
                name_candidates: Vec::new(),
            });
        }
    }
    items
}
