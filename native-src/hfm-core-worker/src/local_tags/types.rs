use serde::{Deserialize, Serialize};

use crate::mutation_protocol::TagMutationProtocolResult;

#[derive(Clone, Debug)]
pub struct LocalTagsCommandConfig {
    pub input_path: String,
}


#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsReadPayload {
    pub db_path: String,
    #[serde(default)]
    pub rows: Vec<LocalTagsReadRow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsReadRow {
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub font_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsSetPayload {
    pub db_path: String,
    pub updated_at: String,
    #[serde(default)]
    pub rows: Vec<LocalTagsSetRow>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsSetRow {
    #[serde(default)]
    pub item_id: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub font_path: String,
    #[serde(default)]
    pub tag_names: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsDeletePayload {
    pub db_path: String,
    #[serde(default)]
    pub tag_name: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsTimings {
    pub elapsed: u128,
    pub rows: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsMutationStateSignal {
    pub mutation_kind: String,
    pub db_path: String,
    pub changed_ids: Vec<String>,
    pub updated_at: String,
    pub local_tags_changed: bool,
    pub cache_invalidated: bool,
    pub page_query_dirty: bool,
    pub metrics_dirty: bool,
    pub known_tags: Vec<String>,
}


#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsReadResult {
    pub ok: bool,
    pub tag_map: std::collections::BTreeMap<String, Vec<String>>,
    pub known_tags: Vec<String>,
    pub signature: String,
    pub timings: LocalTagsTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsSetResult {
    pub ok: bool,
    pub updated_ids: Vec<String>,
    pub written: usize,
    pub previous_known_tags: Vec<String>,
    pub known_tags: Vec<String>,
    pub added_known_tags: Vec<String>,
    pub removed_known_tags: Vec<String>,
    pub retained_empty_tags: Vec<String>,
    pub state_signal: LocalTagsMutationStateSignal,
    pub mutation_protocol: TagMutationProtocolResult,
    pub timings: LocalTagsTimings,
    pub worker_mode: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalTagsDeleteResult {
    pub ok: bool,
    pub updated_ids: Vec<String>,
    pub updated: usize,
    pub previous_known_tags: Vec<String>,
    pub known_tags: Vec<String>,
    pub added_known_tags: Vec<String>,
    pub removed_known_tags: Vec<String>,
    pub state_signal: LocalTagsMutationStateSignal,
    pub mutation_protocol: TagMutationProtocolResult,
    pub timings: LocalTagsTimings,
    pub worker_mode: String,
}
