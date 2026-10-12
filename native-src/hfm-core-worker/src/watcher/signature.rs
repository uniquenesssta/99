use std::fs::Metadata;
use crate::scanner::metadata::{round_timestamp_ms, timestamp_millis};

pub fn metadata_modified_ms(metadata: &Metadata) -> f64 {
    metadata
        .modified()
        .map(timestamp_millis)
        .unwrap_or(0.0)
}

pub fn file_cache_signature(relative_path: &str, size: u64, modified_ms: f64) -> String {
    format!("{}|{}|{}", relative_path.to_ascii_lowercase(), size, round_timestamp_ms(modified_ms))
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn signatures_match_javascript_rounding_for_positive_and_negative_ties() {
        for (millis, expected) in [(0.4, 0), (0.5, 1), (0.7, 1), (0.999, 1),
            (-0.4, 0), (-0.5, 0), (-0.7, -1), (-0.999, -1), (-1.5, -1)] {
            assert_eq!(file_cache_signature("Fonts/Example.ttf", 12, millis), format!("fonts/example.ttf|12|{expected}"));
        }
    }
}
