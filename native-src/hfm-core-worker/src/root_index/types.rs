use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootIndexApplyConfig {
    pub db_path: String,
    pub root_path: String,
    pub storage: String,
    pub input_path: String,
    pub schema_version: i64,
    pub cache_version: i64,
    pub script_detection_version: i64,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RootIndexApplyPayload {
    #[serde(default)]
    pub upserts: Vec<RootIndexUpsert>,
    #[serde(default)]
    pub deletes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootIndexUpsert {
    pub relative_path: String,
    pub entry: RootIndexEntry,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootIndexEntry {
    pub cache_key: String,
    #[serde(default)]
    pub file_size: f64,
    #[serde(default)]
    pub modified_at: f64,
    pub created_at: Option<f64>,
    pub status: String,
    pub font: Option<Value>,
    pub message: Option<String>,
    pub content_hash: Option<String>,
    pub cached_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct RootIndexApplyResult {
    pub count: i64,
    pub upserts: usize,
    pub deletes: usize,
}
