use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct PreviewCacheCommandConfig {
    pub input_path: String,
}

fn default_schema_version() -> i64 {
    1
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheReadStatusPayload {
    pub db_path: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    pub preview_key: String,
    pub output_path: String,
    pub now: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheApplyPayload {
    pub db_path: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    #[serde(default)]
    pub rows: Vec<PreviewCacheRow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheDeletePayload {
    pub db_path: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    #[serde(default)]
    pub keys: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheQueryPayload {
    pub db_path: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    pub now: String,
    #[serde(default)]
    pub rows: Vec<PreviewCacheQueryRow>,
    #[serde(default)]
    pub accepted_statuses: Vec<String>,
    #[serde(default)]
    pub touch_matched: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheTouchPayload {
    pub db_path: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    pub now: String,
    #[serde(default)]
    pub keys: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheBatchPayload {
    pub db_path: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    pub now: String,
    #[serde(default)]
    pub rows: Vec<PreviewCacheQueryRow>,
    #[serde(default)]
    pub accepted_statuses: Vec<String>,
    #[serde(default)]
    pub touch_matched: bool,
    #[serde(default)]
    pub check_files: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheMaintenancePayload {
    pub db_path: String,
    #[serde(default = "default_schema_version")]
    pub schema_version: i64,
    pub now: String,
    #[serde(default)]
    pub preview_dirs: Vec<String>,
    #[serde(default)]
    pub preview_ok_retention_ms: i64,
    #[serde(default)]
    pub orphan_retention_ms: i64,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PreviewCacheRow {
    pub preview_key: String,
    #[serde(default)]
    pub font_id: Option<String>,
    #[serde(default)]
    pub source_path: Option<String>,
    #[serde(default)]
    pub root_path: Option<String>,
    #[serde(default)]
    pub relative_path: String,
    pub output_path: String,
    #[serde(default)]
    pub font_signature: String,
    #[serde(default)]
    pub text_hash: String,
    #[serde(default)]
    pub font_size: i64,
    #[serde(default)]
    pub width: i64,
    #[serde(default)]
    pub height: i64,
    #[serde(default = "default_storage")]
    pub storage: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub fail_count: i64,
    #[serde(default)]
    pub generated_at: Option<String>,
    #[serde(default)]
    pub accessed_at: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheQueryRow {
    pub id: String,
    pub preview_key: String,
    pub output_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheReadStatusResult {
    pub ok: bool,
    pub status: Option<String>,
    pub matched: bool,
    pub touched: bool,
    pub timings: PreviewCacheTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheApplyResult {
    pub ok: bool,
    pub written: usize,
    pub timings: PreviewCacheTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheDeleteResult {
    pub ok: bool,
    pub deleted: usize,
    pub timings: PreviewCacheTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheQueryResult {
    pub ok: bool,
    pub rows: Vec<PreviewCacheQueryMatch>,
    pub matched: usize,
    pub touched: usize,
    pub timings: PreviewCacheTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheTouchResult {
    pub ok: bool,
    pub touched: usize,
    pub timings: PreviewCacheTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheBatchResult {
    pub ok: bool,
    pub rows: Vec<PreviewCacheBatchMatch>,
    pub matched: usize,
    pub touched: usize,
    pub missing_ids: Vec<String>,
    pub timings: PreviewCacheTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheBatchMatch {
    pub id: String,
    pub preview_key: String,
    pub output_path: String,
    pub status: Option<String>,
    pub matched: bool,
    pub file_exists: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheMaintenanceResult {
    pub ok: bool,
    pub checked_rows: usize,
    pub stale_rows: usize,
    pub removed_files: usize,
    pub removed_orphan_files: usize,
    pub errors: Vec<String>,
    pub timings: PreviewCacheTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheQueryMatch {
    pub id: String,
    pub preview_key: String,
    pub output_path: String,
    pub status: Option<String>,
    pub matched: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewCacheTimings {
    pub elapsed: u128,
    pub rows: usize,
}

fn default_storage() -> String {
    "local".to_string()
}

fn default_status() -> String {
    "pending".to_string()
}
