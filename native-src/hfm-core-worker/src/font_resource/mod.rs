use std::fs;
use std::time::Instant;

mod activation_files;
mod types;
mod windows;

pub use activation_files::run_font_activation_files;
pub use types::FontResourceCommandConfig;

use self::types::{
    FontNotifyPayload, FontNotifyResult, FontRegistryApplyPayload, FontRegistryDeletePayload,
    FontRegistryResult, FontResourceBatchPayload, FontResourceBatchResult,
};

fn read_payload<T: serde::de::DeserializeOwned>(config: &FontResourceCommandConfig) -> Result<T, String> {
    let raw = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    serde_json::from_str::<T>(&raw).map_err(|error| error.to_string())
}

fn unique_non_empty(values: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    let mut out = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_ascii_lowercase();
        if seen.insert(key) {
            out.push(trimmed.to_string());
        }
    }
    out
}

fn batch_result_json(
    rows: Vec<types::FontResourceBatchRow>,
    started_at: Instant,
    worker_mode: &'static str,
) -> Result<String, String> {
    let count = rows.iter().filter(|row| row.ok).count();
    let failed = rows.len().saturating_sub(count);
    let result = FontResourceBatchResult {
        ok: failed == 0,
        count,
        failed,
        results: rows,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode,
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn add_font_resources(config: &FontResourceCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = read_payload::<FontResourceBatchPayload>(config)?;
    let paths = unique_non_empty(input.paths);
    let rows = windows::add_font_resources(&paths);
    if input.notify && rows.iter().any(|row| row.ok) {
        let _ = windows::notify_font_change(input.strong);
    }
    batch_result_json(rows, started_at, "rust-font-resource-add")
}

pub fn remove_font_resources(config: &FontResourceCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = read_payload::<FontResourceBatchPayload>(config)?;
    let paths = unique_non_empty(input.paths);
    let rows = windows::remove_font_resources(&paths);
    if input.notify && rows.iter().any(|row| row.ok) {
        let _ = windows::notify_font_change(input.strong);
    }
    batch_result_json(rows, started_at, "rust-font-resource-remove")
}

pub fn notify_font_change(config: &FontResourceCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = read_payload::<FontNotifyPayload>(config)?;
    windows::notify_font_change(input.strong)?;
    let result = FontNotifyResult {
        ok: true,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-font-change-notify",
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn apply_font_registry(config: &FontResourceCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = read_payload::<FontRegistryApplyPayload>(config)?;
    let records: Vec<_> = input
        .records
        .into_iter()
        .filter(|record| !record.name.trim().is_empty() && !record.path.trim().is_empty())
        .collect();
    let (count, failed) = windows::apply_registry_records(&records)?;
    let result = FontRegistryResult {
        ok: failed == 0,
        count,
        failed,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-font-registry-apply",
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

pub fn delete_font_registry(config: &FontResourceCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = read_payload::<FontRegistryDeletePayload>(config)?;
    let names = unique_non_empty(input.names);
    let count = windows::delete_registry_values(&names)?;
    let result = FontRegistryResult {
        ok: true,
        count,
        failed: 0,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-font-registry-delete",
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}
