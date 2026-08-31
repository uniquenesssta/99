use std::path::Path;

pub fn path_file_name(path: &str) -> Option<String> {
    Path::new(path)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
}

pub fn path_file_stem(path: &str) -> Option<String> {
    Path::new(path)
        .file_stem()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
}

pub fn normalize_compare_text(input: &str) -> String {
    let mut value = input.to_lowercase();
    for token in [
        "(truetype)",
        "(opentype)",
        "truetype",
        "opentype",
        "regular",
        "bold",
        "italic",
        "字体",
        "常规",
        "粗体",
        "斜体",
    ] {
        value = value.replace(token, "");
    }
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric() || ('\u{4e00}'..='\u{9fa5}').contains(&ch))
        .collect()
}

pub fn is_usable_installed_name_candidate(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    let count = value.chars().count();
    if count >= 6 {
        return true;
    }
    count >= 2 && value.chars().any(|ch| ('\u{4e00}'..='\u{9fa5}').contains(&ch))
}

pub fn looks_like_windows_absolute_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/'))
        || value.starts_with("\\\\")
}
