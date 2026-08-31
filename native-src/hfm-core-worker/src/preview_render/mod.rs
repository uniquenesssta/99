mod types;

#[cfg(windows)]
mod windows;
#[cfg(not(windows))]
mod non_windows;

use std::fs;
use std::time::Instant;

use crate::json::escape_json;

pub use types::{PreviewRenderCommandConfig, PreviewRenderRequest};

pub fn render_preview_image(config: &PreviewRenderCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path)
        .map_err(|error| format!("failed to read preview render input: {}", error))?;
    let request: PreviewRenderRequest = serde_json::from_str(&input)
        .map_err(|error| format!("failed to parse preview render input: {}", error))?;
    let request = request.normalized();
    validate_request(&request)?;

    platform_render_preview_image(&request)?;

    Ok(format!(
        "{{\"ok\":true,\"engine\":\"rust-private-gdi\",\"outputPath\":\"{}\",\"elapsedMs\":{}}}",
        escape_json(&request.output_path),
        started_at.elapsed().as_millis()
    ))
}

fn validate_request(request: &PreviewRenderRequest) -> Result<(), String> {
    if request.font_path.trim().is_empty() && request.system_font_family_candidates.is_empty() {
        return Err("fontPath and systemFontFamilyCandidates are empty".to_string());
    }
    if request.output_path.trim().is_empty() {
        return Err("outputPath is empty".to_string());
    }
    Ok(())
}

#[cfg(windows)]
fn platform_render_preview_image(request: &PreviewRenderRequest) -> Result<(), String> {
    windows::render_preview_image(request)
}

#[cfg(not(windows))]
fn platform_render_preview_image(request: &PreviewRenderRequest) -> Result<(), String> {
    non_windows::render_preview_image(request)
}
