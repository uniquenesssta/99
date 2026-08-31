use serde::{Deserialize, Serialize};

use crate::mutation_protocol::TagMutationProtocolResult;

#[derive(Clone, Debug)]
pub struct SharedMetadataCommandConfig {
    pub input_path: String,
}


#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataKnownTagsPayload {
    #[serde(default)]
    pub roots: Vec<SharedMetadataKnownTagsRoot>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataKnownTagsRoot {
    #[serde(default)]
    pub root_path: String,
    #[serde(default)]
    pub db_path: String,
}



#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataOverlayReadPayload {
    #[serde(default)]
    pub root_path: String,
    #[serde(default)]
    pub db_path: String,
    #[serde(default)]
    pub entries: Vec<SharedMetadataOverlayReadEntry>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataOverlayReadEntry {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub font_id: String,
    #[serde(default)]
    pub relative_path: String,
    #[serde(default)]
    pub path_key: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataOverlayMatchedEntry {
    pub key: String,
    pub tag_names: Vec<String>,
    pub favorite: bool,
    pub delete_protected: bool,
    pub matched_by: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataOverlayReadResult {
    pub ok: bool,
    pub root_path: String,
    pub db_path: String,
    pub signature: String,
    pub matched: Vec<SharedMetadataOverlayMatchedEntry>,
    pub rows: usize,
    pub requested: usize,
    pub timings: SharedMetadataTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataApplyPayload {
    pub db_path: String,
    #[serde(default)]
    pub root_path: String,
    pub updated_at: String,
    #[serde(default)]
    pub updated_by: String,
    #[serde(default)]
    pub writer_pid: i64,
    #[serde(default)]
    pub rows: Vec<SharedMetadataApplyRow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataApplyRow {
    pub font_id: String,
    #[serde(default)]
    pub relative_path: String,
    #[serde(default)]
    pub path_key: String,
    #[serde(default = "default_tag_names_json")]
    pub tag_names_json: String,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub delete_protected: bool,
    #[serde(default = "default_event_type")]
    pub event_type: String,
    #[serde(default = "default_tag_names_json")]
    pub base_tag_names_json: String,
    #[serde(default = "default_merge_policy")]
    pub merge_policy: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataRemoveTagPayload {
    pub db_path: String,
    #[serde(default)]
    pub root_path: String,
    #[serde(default)]
    pub tag_name: String,
    pub updated_at: String,
    #[serde(default)]
    pub updated_by: String,
    #[serde(default)]
    pub writer_pid: i64,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataTimings {
    pub elapsed: u128,
    pub rows: usize,
}



#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataKnownTagsRootResult {
    pub root_path: String,
    pub db_path: String,
    pub signature: String,
    pub known_tags: Vec<String>,
    pub rows: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataKnownTagsResult {
    pub ok: bool,
    pub known_tags: Vec<String>,
    pub roots: Vec<SharedMetadataKnownTagsRootResult>,
    pub timings: SharedMetadataTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataMutationStateSignal {
    pub mutation_kind: String,
    pub db_path: String,
    pub root_path: String,
    pub changed_ids: Vec<String>,
    pub updated_at: String,
    pub signature: String,
    pub shared_metadata_changed: bool,
    pub cache_invalidated: bool,
    pub merged_index_dirty: bool,
    pub page_query_dirty: bool,
    pub metrics_dirty: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataApplyResult {
    pub ok: bool,
    pub written: usize,
    pub events: usize,
    pub changed_ids: Vec<String>,
    pub signature: String,
    pub state_signal: SharedMetadataMutationStateSignal,
    pub mutation_protocol: TagMutationProtocolResult,
    pub timings: SharedMetadataTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataRemoveTagResult {
    pub ok: bool,
    pub updated_ids: Vec<String>,
    pub updated: usize,
    pub signature: String,
    pub state_signal: SharedMetadataMutationStateSignal,
    pub mutation_protocol: TagMutationProtocolResult,
    pub timings: SharedMetadataTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedMetadataSignatureResult {
    pub ok: bool,
    pub signature: String,
    pub timings: SharedMetadataTimings,
    pub worker_mode: String,
}

fn default_tag_names_json() -> String {
    "[]".to_string()
}

fn default_merge_policy() -> String {
    "replace".to_string()
}

fn default_event_type() -> String {
    "update".to_string()
}

