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
