use serde::Deserialize;

#[derive(Clone, Debug)]
pub struct PreviewRenderCommandConfig {
    pub input_path: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRenderRequest {
    #[serde(default)]
    pub font_path: String,
    #[serde(default)]
    pub prefer_system_font: bool,
    #[serde(default)]
    pub system_font_family_candidates: Vec<String>,
    #[serde(default)]
    pub text: String,
    #[serde(default = "default_font_size")]
    pub font_size: f32,
    #[serde(default = "default_width")]
    pub width: u32,
    #[serde(default = "default_height")]
    pub height: u32,
    pub output_path: String,
}

fn default_font_size() -> f32 { 72.0 }
fn default_width() -> u32 { 900 }
fn default_height() -> u32 { 260 }

impl PreviewRenderRequest {
    pub fn normalized(mut self) -> Self {
        if self.text.trim().is_empty() {
            self.text = "字体预览 AaBb 123".to_string();
        }
        self.font_size = self.font_size.clamp(8.0, 320.0);
        self.width = self.width.clamp(64, 4096);
        self.height = self.height.clamp(32, 2048);
        self.system_font_family_candidates = self.system_font_family_candidates
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value.len() <= 160 && !value.contains('\\') && !value.contains('/'))
            .take(8)
            .collect();
        self
    }
}
