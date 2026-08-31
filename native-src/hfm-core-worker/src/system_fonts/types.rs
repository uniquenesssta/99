use serde::Serialize;

#[derive(Clone, Debug)]
pub struct SystemInstalledFontsConfig {
    pub windows_fonts_dir: String,
    pub current_user_fonts_dir: String,
    pub extensions: Vec<String>,
    pub include_name_candidates: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInstalledFontRecord {
    pub source: String,
    pub registry_name: String,
    pub value: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub name_candidates: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct SystemInstalledFontsResult {
    pub json: String,
}
