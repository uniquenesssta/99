use std::env;
use std::path::PathBuf;

use super::normalize::{looks_like_windows_absolute_path, path_file_name};
use super::types::SystemInstalledFontRecord;

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

pub fn read_registry_installed_fonts(windows_fonts_dir: &str) -> Result<Vec<SystemInstalledFontRecord>, String> {
    #[cfg(windows)]
    {
        crate::font_registry::read().map_err(|error|error.to_string()).map(|entries|entries.into_iter().map(|entry| {
            let path=possible_installed_font_path(&entry.value,windows_fonts_dir);
            SystemInstalledFontRecord {source:entry.scope.into(),registry_name:entry.name,value:entry.value,
                file_name:path_file_name(&path),path:Some(path),name_candidates:Vec::new()}
        }).collect())
    }
    #[cfg(not(windows))]
    {let _=windows_fonts_dir;Ok(Vec::new())}
}
