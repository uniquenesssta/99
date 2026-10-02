use std::path::PathBuf;

use sha1::{Digest, Sha1};

pub fn normalize_native_path_text(value: &str) -> String {
    let mut normalized = value.trim().replace('/', "\\");
    let upper = normalized.to_ascii_uppercase();
    if upper.starts_with("\\\\?\\UNC\\") {
        normalized = format!("\\\\{}", &normalized[8..]);
    } else if upper.starts_with("\\\\?\\") {
        normalized = normalized[4..].to_string();
    }

    let is_unc = normalized.starts_with("\\\\");
    let body = if is_unc { &normalized[2..] } else { normalized.as_str() };
    let mut collapsed = String::with_capacity(normalized.len());
    let mut previous_was_separator = false;
    for character in body.chars() {
        if character == '\\' {
            if previous_was_separator {
                continue;
            }
            previous_was_separator = true;
        } else {
            previous_was_separator = false;
        }
        collapsed.push(character);
    }

    let mut result = if is_unc {
        format!("\\\\{}", collapsed)
    } else {
        collapsed
    };
    while result.ends_with('\\') && result.len() > 3 {
        result.pop();
    }
    result
}

pub fn normalize_path_for_compare(value: &str) -> String {
    normalize_native_path_text(value).to_lowercase()
}

fn is_absolute_path(input: &str) -> bool {
    let value = input.trim();
    value.starts_with("\\\\")
        || value.starts_with('/')
        || value.starts_with('\\')
        || (value.len() >= 3
            && value.as_bytes()[1] == b':'
            && (value.as_bytes()[2] == b'\\' || value.as_bytes()[2] == b'/'))
}

pub fn runtime_path(root_path: &str, entry_path: &str) -> String {
    if is_absolute_path(entry_path) {
        return entry_path.to_string();
    }
    let clean = entry_path.replace('\\', "/");
    let mut path = PathBuf::from(root_path);
    for part in clean.split('/').filter(|part| !part.is_empty()) {
        path.push(part);
    }
    path.to_string_lossy().to_string()
}

pub fn file_name_from_path(file_path: &str) -> String {
    file_path
        .rsplit(|ch| ch == '\\' || ch == '/')
        .next()
        .unwrap_or(file_path)
        .to_string()
}

fn sha1_hex(input: &str) -> String {
    format!("{:x}", Sha1::digest(input.as_bytes()))
}

pub fn shared_font_id(cache_identity: &str, size: f64, mtime_ms: f64) -> String {
    let signature = format!(
        "{}|{}|{}",
        cache_identity.to_lowercase(),
        size as i64,
        mtime_ms.round() as i64
    );
    sha1_hex(&signature)
}

// Concrete-file identity only. Shared metadata/cache IDs remain unchanged.
// Root aliases must already have been resolved by the existing path authority.
pub fn file_runtime_font_id(file_path: &str, size: f64, mtime_ms: f64) -> Result<String, String> {
    let normalized = normalize_path_for_compare(file_path);
    let bytes = normalized.as_bytes();
    let drive = bytes.len() > 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'\\';
    let unc = normalized.starts_with("\\\\") && normalized[2..].split('\\').filter(|part| !part.is_empty()).count() >= 3;
    if (!drive && !unc) || normalized.split('\\').any(|part| part == "." || part == "..")
        || !size.is_finite() || size < 0.0 || size.fract() != 0.0 || size > 9_007_199_254_740_991.0 || !mtime_ms.is_finite() || mtime_ms.abs() > 9_007_199_254_740_991.0 {
        return Err("Concrete font identity requires a canonical absolute file path and valid file stat".to_string());
    }
    // JS Math.round rounds negative half values towards +infinity as well.
    let rounded_mtime = mtime_ms.floor() + if mtime_ms - mtime_ms.floor() >= 0.5 { 1.0 } else { 0.0 };
    let signature = format!("{}|{}|{}", normalized, size as i64, rounded_mtime as i64);
    Ok(format!("file-v2:{}", sha1_hex(&signature)))
}

#[cfg(test)]
mod tests {
    use super::{normalize_native_path_text, normalize_path_for_compare, file_runtime_font_id, shared_font_id};

    #[test]
    fn concrete_identity_matches_typescript_contract_vectors() {
        let vectors: serde_json::Value = serde_json::from_str(include_str!("../../../../build/diagnostics/fixtures/font-file-identity.json")).unwrap();
        for row in vectors.as_array().unwrap() {
            assert_eq!(file_runtime_font_id(row["path"].as_str().unwrap(), row["size"].as_f64().unwrap(), row["mtimeMs"].as_f64().unwrap()).unwrap(), row["expected"].as_str().unwrap());
        }
    }

    #[test]
    fn concrete_identity_keeps_cross_root_copies_separate() {
        assert_ne!(file_runtime_font_id(r"C:\root-a\same.ttf", 1234.0, 1700000000000.0).unwrap(),
                   file_runtime_font_id(r"C:\root-b\same.ttf", 1234.0, 1700000000000.0).unwrap());
        assert_eq!(file_runtime_font_id(r"\\?\C:/ROOT-A//same.ttf", 1234.0, 1700000000000.0).unwrap(),
                   file_runtime_font_id(r"c:\root-a\same.ttf", 1234.0, 1700000000000.0).unwrap());
        assert_eq!(file_runtime_font_id(r"\\?\UNC\server\share\same.ttf", 1234.0, 1700000000000.0).unwrap(),
                   file_runtime_font_id(r"\\SERVER\share\same.ttf", 1234.0, 1700000000000.0).unwrap());
        assert!(file_runtime_font_id("same.ttf", 1234.0, 1.0).is_err());
        assert!(file_runtime_font_id(r"C:\a\..\same.ttf", 1234.0, 1.0).is_err());
        assert!(file_runtime_font_id(r"C:\same.ttf", f64::NAN, 1.0).is_err());
        assert!(!shared_font_id("same.ttf", 1234.0, 1.0).starts_with("file-v2:"));
    }

    #[test]
    fn strips_drive_device_prefix() {
        assert_eq!(normalize_native_path_text(r"\\?\O:\字体\子目录\"), r"O:\字体\子目录");
    }

    #[test]
    fn converts_unc_device_prefix_without_losing_unc_root() {
        assert_eq!(
            normalize_native_path_text(r"\\?\UNC\server\share\字体\\子目录\"),
            r"\\server\share\字体\子目录"
        );
    }

    #[test]
    fn comparison_form_is_case_insensitive_and_separator_stable() {
        assert_eq!(
            normalize_path_for_compare(r"\\?\O:/字体//子目录/"),
            normalize_path_for_compare(r"o:\字体\子目录")
        );
    }
}
