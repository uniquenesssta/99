use std::fs;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use super::types::FontResourceCommandConfig;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationFilesPayload {
    #[serde(default)]
    copies: Vec<ActivationCopyJob>,
    #[serde(default)]
    deletes: Vec<String>,
    #[serde(default)]
    allowed_delete_dir: String,
    #[serde(default)]
    allowed_name_prefix: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivationCopyJob {
    id: String,
    source: String,
    dest: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationFileRow {
    id: String,
    source: String,
    dest: String,
    ok: bool,
    mode: String,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationDeleteRow {
    path: String,
    ok: bool,
    message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ActivationFilesResult {
    ok: bool,
    copied: usize,
    reused: usize,
    deleted: usize,
    failed: usize,
    copy_results: Vec<ActivationFileRow>,
    delete_results: Vec<ActivationDeleteRow>,
    elapsed_ms: u128,
    worker_mode: &'static str,
}

pub fn run_font_activation_files(config: &FontResourceCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let raw = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: ActivationFilesPayload = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let mut copied = 0usize;
    let mut reused = 0usize;
    let mut deleted = 0usize;
    let mut failed = 0usize;
    let mut copy_results = Vec::new();
    let mut delete_results = Vec::new();

    for job in payload.copies {
        let row = copy_one(&job);
        if row.ok && row.mode == "copied" {
            copied += 1;
        } else if row.ok && row.mode == "reused" {
            reused += 1;
        } else if !row.ok {
            failed += 1;
        }
        copy_results.push(row);
    }

    for path in payload.deletes {
        let row = delete_one(&path, &payload.allowed_delete_dir, &payload.allowed_name_prefix);
        if row.ok {
            deleted += 1;
        } else {
            failed += 1;
        }
        delete_results.push(row);
    }

    let result = ActivationFilesResult {
        ok: failed == 0,
        copied,
        reused,
        deleted,
        failed,
        copy_results,
        delete_results,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-font-activation-files",
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn copy_one(job: &ActivationCopyJob) -> ActivationFileRow {
    let source_path = Path::new(&job.source);
    let dest_path = Path::new(&job.dest);
    if same_path(source_path, dest_path) {
        return ActivationFileRow { id: job.id.clone(), source: job.source.clone(), dest: job.dest.clone(), ok: true, mode: "skipped-same-path".to_string(), message: "ok".to_string() };
    }
    let source_stat = match fs::metadata(source_path) {
        Ok(value) if value.is_file() => value,
        Ok(_) => return fail_copy(job, "source is not a file"),
        Err(error) => return fail_copy(job, &error.to_string()),
    };
    if let Ok(target_stat) = fs::metadata(dest_path) {
        if target_stat.is_file() && target_stat.len() == source_stat.len() {
            return ActivationFileRow { id: job.id.clone(), source: job.source.clone(), dest: job.dest.clone(), ok: true, mode: "reused".to_string(), message: "ok".to_string() };
        }
    }
    if let Some(parent) = dest_path.parent() {
        if let Err(error) = fs::create_dir_all(parent) {
            return fail_copy(job, &error.to_string());
        }
    }
    match fs::copy(source_path, dest_path) {
        Ok(_) => ActivationFileRow { id: job.id.clone(), source: job.source.clone(), dest: job.dest.clone(), ok: true, mode: "copied".to_string(), message: "ok".to_string() },
        Err(error) => fail_copy(job, &error.to_string()),
    }
}

fn fail_copy(job: &ActivationCopyJob, message: &str) -> ActivationFileRow {
    ActivationFileRow { id: job.id.clone(), source: job.source.clone(), dest: job.dest.clone(), ok: false, mode: "failed".to_string(), message: message.to_string() }
}

fn delete_one(path: &str, allowed_dir: &str, prefix: &str) -> ActivationDeleteRow {
    if !is_safe_delete_path(path, allowed_dir, prefix) {
        return ActivationDeleteRow { path: path.to_string(), ok: false, message: "unsafe temporary font path".to_string() };
    }
    match fs::remove_file(path) {
        Ok(_) => ActivationDeleteRow { path: path.to_string(), ok: true, message: "ok".to_string() },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ActivationDeleteRow { path: path.to_string(), ok: true, message: "already missing".to_string() },
        Err(error) => ActivationDeleteRow { path: path.to_string(), ok: false, message: error.to_string() },
    }
}

fn is_safe_delete_path(path: &str, allowed_dir: &str, prefix: &str) -> bool {
    if allowed_dir.trim().is_empty() || prefix.trim().is_empty() {
        return false;
    }
    let path_key = normalize_for_compare(path);
    let dir_key = normalize_for_compare(allowed_dir);
    let file_name = Path::new(path).file_name().map(|value| value.to_string_lossy().to_string()).unwrap_or_default();
    (path_key == dir_key || path_key.starts_with(&format!("{}\\", dir_key))) && file_name.starts_with(prefix)
}

fn same_path(a: &Path, b: &Path) -> bool {
    normalize_for_compare(&a.to_string_lossy()) == normalize_for_compare(&b.to_string_lossy())
}

fn normalize_for_compare(value: &str) -> String {
    value.replace('/', "\\").trim_end_matches('\\').to_ascii_lowercase()
}
