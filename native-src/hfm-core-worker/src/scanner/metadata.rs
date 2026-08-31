use std::time::{SystemTime, UNIX_EPOCH};

pub fn timestamp_ms(value: SystemTime) -> u128 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}
