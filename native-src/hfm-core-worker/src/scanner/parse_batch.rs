use std::fs;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::family::FontFamilyHint;
use crate::font_parser::{FontNameInfo, FontScriptInfo, FontStyleInfo};

use super::font_file::{scan_font_file, FontFileScanOptions};

#[derive(Clone, Debug)]
pub struct FontParseBatchCommandConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchPayload {
    #[serde(default)]
    jobs: Vec<FontParseBatchJob>,
    #[serde(default)]
    full_hash: bool,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchJob {
    job_id: String,
    root_path: String,
    file_path: String,
    cache_key: String,
    signature: String,
    #[serde(default)]
    file_size: f64,
    #[serde(default)]
    modified_at: f64,
    #[serde(default)]
    created_at: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchError {
    job_id: String,
    path: String,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchResult {
    job_id: String,
    root_path: String,
    file_path: String,
    cache_key: String,
    signature: String,
    file_size: f64,
    modified_at: f64,
    created_at: f64,
    signature_valid: bool,
    format_hint: String,
    quick_hash: String,
    content_hash: String,
    hash_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name_hint: Option<FontNameInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    script_hint: Option<FontScriptInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    style_hint: Option<FontStyleInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    family_hint: Option<FontFamilyHint>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FontParseBatchOutput {
    ok: bool,
    results: Vec<FontParseBatchResult>,
    errors: Vec<FontParseBatchError>,
    count: usize,
    elapsed_ms: u128,
    worker_mode: &'static str,
}

pub fn parse_font_batch(config: &FontParseBatchCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let payload_text = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: FontParseBatchPayload = serde_json::from_str(&payload_text).map_err(|error| error.to_string())?;
    let options = FontFileScanOptions {
        probe_names: true,
        probe_scripts: true,
        probe_style: true,
        probe_family: true,
        full_hash: payload.full_hash,
    };

    let mut results = Vec::with_capacity(payload.jobs.len());
    let mut errors = Vec::new();

    for job in payload.jobs {
        let path = Path::new(&job.file_path);
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                errors.push(FontParseBatchError {
                    job_id: job.job_id,
                    path: job.file_path,
                    message: error.to_string(),
                });
                continue;
            }
        };

        match scan_font_file(path, &metadata, &options) {
            Ok(entry) => {
                results.push(FontParseBatchResult {
                    job_id: job.job_id,
                    root_path: job.root_path,
                    file_path: job.file_path,
                    cache_key: job.cache_key,
                    signature: job.signature,
                    file_size: if job.file_size > 0.0 { job.file_size } else { entry.size as f64 },
                    modified_at: if job.modified_at > 0.0 { job.modified_at } else { entry.modified_ms as f64 },
                    created_at: if job.created_at > 0.0 { job.created_at } else { entry.created_ms as f64 },
                    signature_valid: entry.signature_valid,
                    format_hint: entry.format,
                    quick_hash: entry.quick_hash.clone(),
                    content_hash: if entry.content_hash.is_empty() { entry.quick_hash.clone() } else { entry.content_hash },
                    hash_kind: entry.hash_kind,
                    name_hint: entry.name_hint,
                    script_hint: entry.script_hint,
                    style_hint: entry.style_hint,
                    family_hint: entry.family_hint,
                });
            }
            Err(error) => {
                errors.push(FontParseBatchError {
                    job_id: job.job_id,
                    path: job.file_path,
                    message: error.to_string(),
                });
            }
        }
    }

    let output = FontParseBatchOutput {
        ok: true,
        count: results.len(),
        results,
        errors,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-font-parse-batch",
    };
    serde_json::to_string(&output).map_err(|error| error.to_string())
}
