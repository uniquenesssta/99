use std::fs::Metadata;
use std::time::UNIX_EPOCH;


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
