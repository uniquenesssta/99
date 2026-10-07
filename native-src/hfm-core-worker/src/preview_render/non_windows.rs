use super::PreviewRenderRequest;

pub fn render_preview_image(_request: &PreviewRenderRequest) -> Result<(), String> {
    Err("rust preview rendering is only available on Windows".to_string())
}
