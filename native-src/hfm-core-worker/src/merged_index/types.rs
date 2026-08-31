use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexPageQueryConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexPageQueryPayload {
    pub query_key: String,
    #[serde(default)]
    pub request: Value,
    #[serde(default)]
    pub limit: i64,
    #[serde(default)]
    pub offset: i64,
    #[serde(default)]
    pub roots: Vec<String>,
    pub merged_index_db_path: String,
    pub library_db_path: String,
    pub schema_version: i64,
    #[serde(default)]
    pub tag_revision: Value,
    pub sql: MergedIndexPageSqlParts,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexPageSqlParts {
    pub sql: String,
    pub count_sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    #[serde(default)]
    pub count_params: Vec<Value>,
    #[serde(default)]
    pub used_like: bool,
}

#[derive(Clone, Debug)]
pub struct MergedIndexPageQueryResult {
    pub json: String,
}


#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexIdsQueryConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexIdsQueryPayload {
    pub query_key: String,
    #[serde(default)]
    pub request: Value,
    #[serde(default)]
    pub limit: i64,
    #[serde(default)]
    pub roots: Vec<String>,
    pub merged_index_db_path: String,
    pub library_db_path: String,
    pub schema_version: i64,
    #[serde(default)]
    pub tag_revision: Value,
    pub sql: MergedIndexIdsSqlParts,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexIdsSqlParts {
    pub sql: String,
    #[serde(default)]
    pub params: Vec<Value>,
    #[serde(default)]
    pub used_like: bool,
}

#[derive(Clone, Debug)]
pub struct MergedIndexIdsQueryResult {
    pub json: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexMetricsQueryConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexRebuildConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexSyncConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergedIndexMetricsQueryPayload {
    #[serde(default)]
    pub roots: Vec<String>,
    pub merged_index_db_path: String,
    pub library_db_path: String,
    pub schema_version: i64,
    #[serde(default)]
    pub tag_revision: Value,
}

#[derive(Clone, Debug)]
pub struct MergedIndexMetricsQueryResult {
    pub json: String,
}

#[derive(Clone, Debug)]
pub struct MergedIndexRebuildResult {
    pub json: String,
}

#[derive(Clone, Debug)]
pub struct MergedIndexSyncResult {
    pub json: String,
}
