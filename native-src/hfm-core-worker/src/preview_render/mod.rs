mod types;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
mod owned_stage;
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
    let mut request = request.normalized()?;
    validate_request(&request)?;
    if config.owned_stage_required != request.owned_stage.is_some() {
        return Err("owned stage requires the dedicated native command and reservation".into());
    }
    #[cfg(not(windows))]
    if config.owned_stage_required { return Err("owned preview staging requires Windows".into()); }
    #[cfg(windows)]
    let owned = request.owned_stage.as_ref().map(|input| owned_stage::PreparedOwnedPreviewStage::prepare(input, &request.output_path)).transpose()?;
    #[cfg(windows)]
    if let Some(stage) = &owned {
        request.output_path = stage.proof.output_path.clone();
        use std::io::Write;
        let mut stderr = std::io::stderr().lock();
        writeln!(stderr, "hfm-owned-preview-ready: {}", serde_json::to_string(&stage.proof).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        stderr.flush().map_err(|e| e.to_string())?;
    }


    let provenance = platform_render_preview_image(&request)?;

    #[cfg(windows)]
    let owned_json = if let Some(stage) = &owned { format!(",\"ownedStage\":{}", serde_json::to_string(&stage.proof).map_err(|e| e.to_string())?) } else { String::new() };
    #[cfg(not(windows))]
    let owned_json = String::new();
    Ok(format!(
        "{{\"ok\":true,\"engine\":\"rust-private-gdi\",\"outputPath\":\"{}\",\"layoutVersion\":\"{}\",\"elapsedMs\":{},\"provenance\":{}{}}}",
        escape_json(&request.output_path),
        request.layout.as_ref().map(|layout| layout.version.as_str()).unwrap_or("legacy"),
        started_at.elapsed().as_millis(),
        provenance, owned_json
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
fn platform_render_preview_image(request: &PreviewRenderRequest) -> Result<serde_json::Value, String> {
    windows::render_preview_image(request)
}

#[cfg(not(windows))]
fn platform_render_preview_image(request: &PreviewRenderRequest) -> Result<serde_json::Value, String> {
    non_windows::render_preview_image(request)
}
