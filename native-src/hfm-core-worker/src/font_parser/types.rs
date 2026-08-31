use serde::Serialize;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontNameInfo {
    pub family_name: Option<String>,
    pub subfamily_name: Option<String>,
    pub full_name: Option<String>,
    pub postscript_name: Option<String>,
    pub preferred_family: Option<String>,
    pub preferred_subfamily: Option<String>,
    pub version: Option<String>,
    pub manufacturer: Option<String>,
    pub record_count: usize,
    pub source_index: usize,
}

impl FontNameInfo {
    pub fn has_any_name(&self) -> bool {
        self.family_name.is_some()
            || self.subfamily_name.is_some()
            || self.full_name.is_some()
            || self.postscript_name.is_some()
            || self.preferred_family.is_some()
            || self.preferred_subfamily.is_some()
            || self.version.is_some()
            || self.manufacturer.is_some()
    }

    pub fn display_family(&self) -> Option<String> {
        self.preferred_family
            .clone()
            .or_else(|| self.family_name.clone())
    }

    pub fn display_subfamily(&self) -> Option<String> {
        self.preferred_subfamily
            .clone()
            .or_else(|| self.subfamily_name.clone())
    }
}


#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontScriptInfo {
    pub scripts: Vec<String>,
    pub range_count: usize,
    pub source_index: usize,
}


#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontStyleInfo {
    pub weight_class: Option<u16>,
    pub width_class: Option<u16>,
    pub italic: bool,
    pub bold: bool,
    pub monospaced: Option<bool>,
    pub units_per_em: Option<u16>,
    pub glyph_count: Option<u16>,
    pub source_index: usize,
}

impl FontStyleInfo {
    pub fn has_any_style(&self) -> bool {
        self.weight_class.is_some()
            || self.width_class.is_some()
            || self.italic
            || self.bold
            || self.monospaced.is_some()
            || self.units_per_em.is_some()
            || self.glyph_count.is_some()
    }
}
