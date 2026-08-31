use crate::preview_render::{render_preview_image, PreviewRenderCommandConfig};

pub fn run_daemon_preview_render_image(config: &PreviewRenderCommandConfig) -> Result<String, String> {
    render_preview_image(config)
}
