use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};


use super::directory::{has_font_extension, should_skip_directory_name};
use super::font_file::{scan_font_file, FontFileScanOptions};
use super::metadata::timestamp_ms;
use super::types::{DirectoryEntry, ListFontFilesResult};

fn completed_entry<T>(entry: std::io::Result<T>, directory: &Path, errors: &mut Vec<(String, String)>) -> Option<T> {
    match entry {
        Ok(entry) => Some(entry),
        Err(error) => { errors.push((directory.to_string_lossy().to_string(), error.to_string())); None }
    }
}

pub fn list_font_files(root: &Path, extensions: &[String], max_entries: usize, probe_names: bool, probe_scripts: bool, probe_style: bool, probe_family: bool, full_hash: bool) -> ListFontFilesResult {
    let mut stack = vec![root.to_path_buf()];
    let mut files = Vec::new();
    let mut directories = Vec::new();
    let mut errors = Vec::new();
    let mut truncated = false;
    let mut last_progress = Instant::now();
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
            let Some(entry) = completed_entry(entry, &dir, &mut errors) else { continue; };
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
            if last_progress.elapsed() >= Duration::from_secs(1) {
                eprintln!("hfm-scan-progress: {{\"files\":{},\"foldersScanned\":{}}}", files.len(), directories.len());
                last_progress = Instant::now();
            }
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

#[cfg(all(test, windows))]
mod scan_completeness_tests {
    use super::*;
    use std::os::windows::fs::OpenOptionsExt;
    use std::io::{Seek, SeekFrom, Write};

    #[test]
    fn iterator_failure_is_incomplete_not_silent_end() {
        let mut errors = Vec::new();
        assert_eq!(completed_entry(Ok(7), Path::new("C:\\private"), &mut errors), Some(7));
        assert_eq!(completed_entry::<u8>(Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied)), Path::new("C:\\private"), &mut errors), None);
        assert_eq!(errors.len(), 1);
    }

    #[test]
    fn inaccessible_font_is_error_but_confirmed_bad_header_is_bad() {
        let dir = std::env::temp_dir().join(format!("hfm-scan-complete-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&dir).unwrap();
        let file = dir.join("private.ttf"); fs::write(&file, b"not-a-font").unwrap();
        let pin = fs::OpenOptions::new().read(true).write(true).share_mode(0).open(&file).unwrap();
        let blocked = list_font_files(&dir, &["ttf".into()], 100, false, false, false, false, false);
        assert!(blocked.files.is_empty()); assert_eq!(blocked.errors.len(), 1);
        drop(pin);
        let complete = list_font_files(&dir, &["ttf".into()], 100, false, false, false, false, false);
        assert!(complete.errors.is_empty()); assert_eq!(complete.files.len(), 1); assert!(!complete.files[0].signature_valid);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn truncated_source_read_does_not_become_bad_or_empty_hash() {
        let file = std::env::temp_dir().join(format!("hfm-scan-short-{}-{}.ttf", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut handle = fs::OpenOptions::new().read(true).write(true).create_new(true).open(&file).unwrap();
        handle.write_all(b"\0\x01\0\0payload").unwrap(); let metadata = handle.metadata().unwrap();
        handle.set_len(0).unwrap(); handle.seek(SeekFrom::Start(0)).unwrap();
        let options = FontFileScanOptions { probe_names:false, probe_scripts:false, probe_style:false, probe_family:false, full_hash:false };
        assert!(super::super::font_file::scan_font_file_from_handle(&file, &mut handle, &metadata, &options).is_err());
        drop(handle); fs::remove_file(&file).unwrap();
    }
}
