use std::time::{SystemTime, UNIX_EPOCH};

pub fn round_timestamp_ms(value: f64) -> i128 {
    // JavaScript Math.round uses the greater integer at ties, including negative
    // timestamps. f64::round instead rounds negative ties away from zero.
    let lower = value.floor();
    if value - lower >= 0.5 { (lower + 1.0) as i128 } else { lower as i128 }
}

pub fn timestamp_millis(value: SystemTime) -> f64 {
    // Match the treeSnapshot decoder's integer-nanosecond quotient/remainder.
    // Converting whole seconds to f64 first can double-round a 100ns Windows
    // timestamp across Math.round's half-millisecond signature boundary.
    let millis = |duration: std::time::Duration| {
        duration.as_millis() as f64 + (duration.subsec_nanos() % 1_000_000) as f64 / 1_000_000.0
    };
    match value.duration_since(UNIX_EPOCH) {
        Ok(duration) => millis(duration),
        Err(error) => -millis(error.duration()),
    }
}

pub fn timestamp_ms(value: SystemTime) -> i128 {
    // Native listing and watcher signatures share signed Math.round values.
    round_timestamp_ms(timestamp_millis(value))
}
