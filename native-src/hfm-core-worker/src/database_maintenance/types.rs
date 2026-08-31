use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct DatabaseMaintenanceCommandConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseMaintenanceFileItem {
    pub label: String,
    pub file_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHealthCheckPayload {
    #[serde(default)]
    pub items: Vec<DatabaseMaintenanceFileItem>,
    #[serde(default = "default_busy_timeout_ms")]
    pub busy_timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHealthItemResult {
    pub label: String,
    pub file_path: String,
    pub ok: bool,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseHealthCheckResult {
    pub ok: bool,
    pub items: Vec<DatabaseHealthItemResult>,
    pub elapsed_ms: u128,
    pub worker_mode: &'static str,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupPayload {
    pub app_name: String,
    pub schema_version: i64,
    pub data_root: String,
    pub backups_root: String,
    pub retention_count: usize,
    pub reason: String,
    pub created_at: String,
    pub backup_dir_name: String,
    #[serde(default)]
    pub items: Vec<DatabaseMaintenanceFileItem>,
    #[serde(default = "default_busy_timeout_ms")]
    pub busy_timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupItemResult {
    pub label: String,
    pub source_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backup_path: Option<String>,
    pub ok: bool,
    pub size_bytes: u64,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupResult {
    pub ok: bool,
    pub reason: String,
    pub backup_dir: String,
    pub items: Vec<DatabaseBackupItemResult>,
    pub created_at: String,
    pub elapsed_ms: u128,
    pub worker_mode: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseBackupManifest<'a> {
    pub ok: bool,
    pub reason: &'a str,
    pub backup_dir: &'a str,
    pub items: &'a [DatabaseBackupItemResult],
    pub created_at: &'a str,
    pub app: &'a str,
    pub schema_version: i64,
    pub data_root: &'a str,
    pub worker_mode: &'static str,
}

pub fn default_busy_timeout_ms() -> u64 {
    5000
}
