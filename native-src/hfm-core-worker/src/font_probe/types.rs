#[derive(Clone, Debug)]
pub struct FontProbeResult {
    pub valid_signature: bool,
    pub format: String,
}

impl FontProbeResult {
    pub fn invalid() -> Self {
        Self {
            valid_signature: false,
            format: "unknown".to_string(),
        }
    }
}
