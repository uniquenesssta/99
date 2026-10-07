use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug)]
pub struct InstallStatusCommandConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusReadPayload {
    #[serde(default)]
    pub groups: Vec<InstallStatusReadGroup>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusReadGroup {
    pub db_path: String,
    #[serde(default)]
    pub items: Vec<InstallStatusReadItem>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusReadItem {
    pub id: String,
    #[serde(default)]
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusSavePayload {
    #[serde(default)]
    pub groups: Vec<InstallStatusSaveGroup>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusSaveGroup {
    #[serde(default)]
    pub root_label: String,
    #[serde(default)]
    pub root_path: String,
    pub db_path: String,
    #[serde(default)]
    pub rows: Vec<InstallStatusSaveRow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusSaveRow {
    pub font_id: String,
    #[serde(default)]
    pub signature: String,
    #[serde(default)]
    pub installed: bool,
    #[serde(default = "default_by")]
    pub by: String,
    #[serde(default)]
    pub matches: Value,
    #[serde(default)]
    pub system_default: bool,
}

fn default_by() -> String {
    "none".to_string()
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusReadResult {
    pub ok: bool,
    pub results: std::collections::BTreeMap<String, InstallStatusCompareResult>,
    pub missing_ids: Vec<String>,
    pub timings: InstallStatusTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusSaveResult {
    pub ok: bool,
    pub written: usize,
    pub groups: usize,
    pub timings: InstallStatusTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusTimings {
    pub elapsed: u128,
    pub groups: usize,
    pub rows: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallStatusCompareResult {
    pub installed: bool,
    pub by: String,
    pub matches: Value,
}
