use serde::{Deserialize, Serialize};

#[derive(Clone, Debug)]
pub struct FontResourceCommandConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontResourceBatchPayload {
    #[serde(default)]
    pub paths: Vec<String>,
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub strong: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRegistryApplyPayload {
    #[serde(default)]
    pub records: Vec<FontRegistryRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRegistryRecord {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRegistryDeletePayload {
    #[serde(default)]
    pub names: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontNotifyPayload {
    #[serde(default)]
    pub strong: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontResourceBatchRow {
    pub path: String,
    pub ok: bool,
    pub count: u32,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontResourceBatchResult {
    pub ok: bool,
    pub count: usize,
    pub failed: usize,
    pub results: Vec<FontResourceBatchRow>,
    pub elapsed_ms: u128,
    pub worker_mode: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontRegistryResult {
    pub ok: bool,
    pub count: usize,
    pub failed: usize,
    pub elapsed_ms: u128,
    pub worker_mode: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontNotifyResult {
    pub ok: bool,
    pub elapsed_ms: u128,
    pub worker_mode: &'static str,
}
