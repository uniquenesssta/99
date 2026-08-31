use serde::Serialize;
use serde_json::Value;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagMutationProtocolResult {
    pub ok: bool,
    pub message: String,
    pub command: String,
    pub domain: String,
    pub mutation_kind: String,
    pub source: String,
    pub changed_ids: Vec<String>,
    pub updated_at: String,
    pub db_path: String,
    pub root_path: String,
    pub known_tags: Vec<String>,
    pub signature: String,
    pub cache_invalidated: bool,
    pub merged_index_dirty: bool,
    pub page_query_dirty: bool,
    pub metrics_dirty: bool,
    pub state_signal: Value,
    pub timings: Value,
    pub worker_mode: String,
}

pub fn json_value<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

pub fn tag_mutation_protocol_result(
    command: &str,
    domain: &str,
    mutation_kind: &str,
    source: &str,
    changed_ids: &[String],
    updated_at: &str,
    db_path: &str,
    root_path: &str,
    known_tags: &[String],
    signature: &str,
    cache_invalidated: bool,
    merged_index_dirty: bool,
    page_query_dirty: bool,
    metrics_dirty: bool,
    state_signal: Value,
    timings: Value,
    worker_mode: &str,
) -> TagMutationProtocolResult {
    TagMutationProtocolResult {
        ok: true,
        message: String::new(),
        command: command.to_string(),
        domain: domain.to_string(),
        mutation_kind: mutation_kind.to_string(),
        source: source.to_string(),
        changed_ids: changed_ids.to_vec(),
        updated_at: updated_at.to_string(),
        db_path: db_path.to_string(),
        root_path: root_path.to_string(),
        known_tags: known_tags.to_vec(),
        signature: signature.to_string(),
        cache_invalidated,
        merged_index_dirty,
        page_query_dirty,
        metrics_dirty,
        state_signal,
        timings,
        worker_mode: worker_mode.to_string(),
    }
}


pub fn tag_mutation_protocol_error(
    command: &str,
    domain: &str,
    mutation_kind: &str,
    message: &str,
) -> TagMutationProtocolResult {
    TagMutationProtocolResult {
        ok: false,
        message: message.to_string(),
        command: command.to_string(),
        domain: domain.to_string(),
        mutation_kind: mutation_kind.to_string(),
        source: "rust-worker".to_string(),
        changed_ids: Vec::new(),
        updated_at: String::new(),
        db_path: String::new(),
        root_path: String::new(),
        known_tags: Vec::new(),
        signature: String::new(),
        cache_invalidated: true,
        merged_index_dirty: domain == "sharedMetadata",
        page_query_dirty: true,
        metrics_dirty: true,
        state_signal: Value::Null,
        timings: Value::Null,
        worker_mode: String::new(),
    }
}
