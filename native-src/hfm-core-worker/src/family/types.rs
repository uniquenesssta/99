use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamilyHint {
    pub family_name: String,
    pub style_name: String,
    pub family_key: String,
    pub style_key: String,
    pub weight_class: Option<u16>,
    pub width_class: Option<u16>,
    pub italic: bool,
    pub bold: bool,
    pub monospaced: Option<bool>,
    pub source_index: usize,
}

impl FontFamilyHint {
    pub fn is_usable(&self) -> bool {
        !self.family_key.is_empty()
    }
}
