use std::fs;
use std::path::{Path, PathBuf};


use super::directory::{has_font_extension, should_skip_directory_name};
use super::font_file::{scan_font_file, FontFileScanOptions};
use super::metadata::timestamp_ms;
use super::types::{DirectoryEntry, ListFontFilesResult};

pub fn list_font_files(root: &Path, extensions: &[String], max_entries: usize, probe_names: bool, probe_scripts: bool, probe_style: bool, probe_family: bool, full_hash: bool) -> ListFontFilesResult {
    let mut stack = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut errors = Vec::new();
    let mut truncated = false;
    let scan_options = FontFileScanOptions {
        probe_names,
        probe_scripts,
        probe_style,
        probe_family,
        full_hash,
    };

    while let Some(dir) = stack.pop() {
        let dir_metadata = match fs::metadata(&dir) {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push((dir.to_string_lossy().to_string(), error.to_string()));
                continue;
            }
        };
        if !dir_metadata.is_dir() {
            continue;
        }

        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) => {
                errors.push((dir.to_string_lossy().to_string(), error.to_string()));
                continue;
            }
        };

        let mut file_count: usize = 0;
        let mut dir_count: usize = 0;
        let mut child_dirs: Vec<PathBuf> = Vec::new();
        let mut font_files: Vec<PathBuf> = Vec::new();

        for entry in entries {
            let Ok(entry) = entry else {
                continue;
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(error) => {
                    errors.push((path.to_string_lossy().to_string(), error.to_string()));
                    continue;
                }
            };

            if file_type.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                if should_skip_directory_name(&name) {
                    continue;
                }
                dir_count += 1;
                child_dirs.push(path);
                continue;
            }

            if file_type.is_file() {
                file_count += 1;
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("._") || !has_font_extension(&path, extensions) {
                    continue;
                }
                font_files.push(path);
            }
        }

        directories.push(DirectoryEntry {
            path: dir.to_string_lossy().to_string(),
            modified_ms: dir_metadata.modified().map(timestamp_ms).unwrap_or(0),
            file_count,
            dir_count,
        });

        for path in font_files {
            let metadata = match fs::metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    errors.push((path.to_string_lossy().to_string(), error.to_string()));
                    continue;
                }
            };

            match scan_font_file(&path, &metadata, &scan_options) {
                Ok(entry) => files.push(entry),
                Err(error) => {
                    errors.push((path.to_string_lossy().to_string(), error.to_string()));
                    continue;
                }
            }

            if files.len() >= max_entries {
                truncated = true;
                break;
            }
        }

        if truncated {
            break;
        }

        for child in child_dirs.into_iter().rev() {
            stack.push(child);
        }
    }

    ListFontFilesResult {
        files,
        directories,
        errors,
        truncated,
    }
}
