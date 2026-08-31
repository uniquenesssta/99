use std::path::{Path, PathBuf};

pub fn normalize_relative_path(value: &str) -> String {
    value
        .replace('\\', "/")
        .trim_start_matches('/')
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

pub fn target_path(root_path: &str, file_name: &str) -> PathBuf {
    Path::new(root_path).join(file_name)
}

pub fn normalized_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .trim_start_matches('.')
        .to_ascii_lowercase()
}
