use serde::Deserialize;

#[derive(Clone, Debug)]
pub struct WatcherPreflightConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherPreflightInput {
    #[serde(default)]
    pub script_detection_version: Option<u64>,
    pub root_path: String,
    pub db_path: String,
    #[serde(default)]
    pub extensions: Vec<String>,
    #[serde(default)]
    pub changes: Vec<WatcherPreflightChange>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherPreflightChange {
    #[serde(default)]
    pub event_type: String,
    #[serde(default)]
    pub file_name: String,
}

#[derive(Clone, Debug)]
pub struct WatcherPreflightResult {
    pub unchanged: bool,
    pub reason: String,
    pub checked_files: usize,
    pub checked_dirs: usize,
}
