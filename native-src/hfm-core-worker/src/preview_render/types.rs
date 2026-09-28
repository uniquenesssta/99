use serde::Deserialize;

// Mirrors previewInputPolicy.ts; checked by diagnostics:preview-input-boundary.
const MIN_WIDTH: u32 = 64;
const MAX_WIDTH: u32 = 4096;
const MIN_HEIGHT: u32 = 32;
const MAX_HEIGHT: u32 = 2048;
const MIN_FONT_SIZE: f64 = 8.0;
const MAX_FONT_SIZE: f64 = 320.0;
const MAX_TEXT_LENGTH: usize = 4096;

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
    pub text: String,
    pub font_size: f64,
    #[serde(deserialize_with = "deserialize_dimension")]
    pub width: u32,
    #[serde(deserialize_with = "deserialize_dimension")]
    pub height: u32,
    pub output_path: String,
    #[serde(default, deserialize_with = "deserialize_layout")]
    pub layout: Option<NativePreviewLayout>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativePreviewLayout {
    pub version: String,
    pub font_size_css_px: f64,
    pub line_height: f64,
    pub padding_top: f64,
    pub padding_right: f64,
    pub padding_bottom: f64,
    pub padding_left: f64,
    pub text_align: String,
    pub white_space: String,
    pub canvas_width: f64,
    pub canvas_height: f64,
    pub pixel_ratio: f64,
}

fn deserialize_layout<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<NativePreviewLayout>, D::Error> {
    NativePreviewLayout::deserialize(deserializer).map(Some)
}

fn deserialize_dimension<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    let value = f64::deserialize(deserializer)?;
    if !value.is_finite() || value.fract() != 0.0 || value < 0.0 || value > u32::MAX as f64 {
        return Err(serde::de::Error::custom("PREVIEW_INPUT_INVALID: dimension"));
    }
    Ok(value as u32)
}

impl PreviewRenderRequest {
    pub fn normalized(mut self) -> Result<Self, String> {
        if !(MIN_WIDTH..=MAX_WIDTH).contains(&self.width)
            || !(MIN_HEIGHT..=MAX_HEIGHT).contains(&self.height)
            || !self.font_size.is_finite()
            || !(MIN_FONT_SIZE..=MAX_FONT_SIZE).contains(&self.font_size)
            || self.text.encode_utf16().take(MAX_TEXT_LENGTH + 1).count() > MAX_TEXT_LENGTH {
            return Err("PREVIEW_INPUT_INVALID: preview limits exceeded".to_string());
        }
        if self.text.is_empty() {
            self.text = "字体预览 AaBb 123".to_string();
        }
        if let Some(layout) = &self.layout {
            let lines = self.text.split('\n').count();
            let grid = layout.version == "grid-v1";
            let line_height = if grid { 1.04 } else { 1.16 };
            let padding_x = if grid { 28.0 } else { 36.0 };
            let sizes = if grid { 26.0..=42.0 } else { 18.0..=72.0 };
            if (!grid && layout.version != "list-v1") || !sizes.contains(&self.font_size)
                || layout.font_size_css_px != self.font_size || layout.line_height != line_height
                || layout.padding_top != 20.0 || layout.padding_bottom != 20.0
                || layout.padding_left != padding_x || layout.padding_right != padding_x
                || layout.text_align != (if grid { "center" } else { "left" }) || layout.white_space != "pre" || layout.pixel_ratio != 1.0
                || layout.canvas_width != 4096.0 || self.width != 4096
                || self.text.contains('\r') || lines > 2
                || layout.canvas_height != (self.font_size * line_height * lines as f64 + 40.0).ceil()
                || layout.canvas_height != self.height as f64 {
                return Err("PREVIEW_INPUT_INVALID: layout".to_string());
            }
        }
        self.system_font_family_candidates = self.system_font_family_candidates
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty() && value.len() <= 160 && !value.contains('\\') && !value.contains('/'))
            .take(8)
            .collect();
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_layout_contract() {
        let layout = serde_json::json!({"version":"list-v1","fontSizeCssPx":44,"lineHeight":1.16,
            "paddingTop":20,"paddingRight":36,"paddingBottom":20,"paddingLeft":36,
            "textAlign":"left","whiteSpace":"pre","canvasWidth":4096,"canvasHeight":143,"pixelRatio":1});
        let request = serde_json::json!({"text":"字体 Ag\nsecond","fontSize":44,"width":4096,"height":143,"outputPath":"out","layout":layout});
        let check = |value: serde_json::Value| serde_json::from_value::<PreviewRenderRequest>(value)
            .map_err(|e| e.to_string()).and_then(|r| r.normalized());
        assert!(check(request.clone()).is_ok());
        for key in layout.as_object().unwrap().keys() {
            let mut changed = request.clone();
            changed["layout"][key] = serde_json::json!("unsupported");
            assert!(check(changed).is_err(), "accepted invalid {}", key);
            let mut missing = request.clone();
            missing["layout"].as_object_mut().unwrap().remove(key);
            assert!(check(missing).is_err(), "accepted missing {}", key);
        }
        let mut third = request.clone(); third["text"] = "a\nb\nc".into(); assert!(check(third).is_err());
        let mut unknown = request.clone(); unknown["layout"]["extra"] = true.into(); assert!(check(unknown).is_err());
        let mut null = request.clone(); null["layout"] = serde_json::Value::Null; assert!(check(null).is_err());
        let mut legacy = request; legacy.as_object_mut().unwrap().remove("layout"); assert!(check(legacy).is_ok());
    }

    #[test]
    fn grid_layout_contract() {
        let layout = serde_json::json!({"version":"grid-v1","fontSizeCssPx":42,"lineHeight":1.04,
            "paddingTop":20,"paddingRight":28,"paddingBottom":20,"paddingLeft":28,
            "textAlign":"center","whiteSpace":"pre","canvasWidth":4096,"canvasHeight":128,"pixelRatio":1});
        let request = serde_json::json!({"text":"安盛aaaa\nSecond","fontSize":42,"width":4096,"height":128,"outputPath":"out","layout":layout});
        let check = |value: serde_json::Value| serde_json::from_value::<PreviewRenderRequest>(value)
            .map_err(|e| e.to_string()).and_then(|r| r.normalized());
        assert!(check(request.clone()).is_ok());
        for key in layout.as_object().unwrap().keys() {
            let mut changed = request.clone(); changed["layout"][key] = "unsupported".into();
            assert!(check(changed).is_err(), "accepted invalid {}", key);
        }
        let mut third = request.clone(); third["text"] = "a\nb\nc".into(); assert!(check(third).is_err());
        let mut list = request.clone(); list["layout"]["version"] = "list-v1".into(); assert!(check(list).is_err());
        let mut large = request; large["fontSize"] = 72.into(); assert!(check(large).is_err());
    }

    #[test]
    fn shared_preview_input_boundaries() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../build/diagnostics/fixtures/preview-input-boundary.fixture.json"
        )).unwrap();
        for (index, case) in fixture["cases"].as_array().unwrap().iter().enumerate() {
            let mut input = fixture["base"].clone();
            for (key, value) in case["patch"].as_object().unwrap() {
                input[key] = value.clone();
            }
            if let Some(repeat) = case["repeat"].as_u64() {
                input["text"] = input["text"].as_str().unwrap().repeat(repeat as usize).into();
            }
            let result = serde_json::from_value::<PreviewRenderRequest>(input.clone())
                .map_err(|error| error.to_string()).and_then(|request| request.normalized());
            assert_eq!(result.is_ok(), case["ok"].as_bool().unwrap(), "case {}", index);
            if let Ok(request) = result {
                let expected = input["text"].as_str().unwrap();
                assert_eq!(request.text, if expected.is_empty() { "字体预览 AaBb 123" } else { expected });
            }
        }
        let input = fixture["base"].clone();
        for text in [r#""\uD800""#, r#""\uDC00""#] {
            assert!(serde_json::from_str::<String>(text).is_err());
        }
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            let mut request: PreviewRenderRequest = serde_json::from_value(input.clone()).unwrap();
            request.font_size = value;
            assert!(request.normalized().is_err());
        }
    }
}
