use serde_json::json;

use super::types::SystemInstalledFontRecord;

pub fn system_installed_fonts_json(
    items: &[SystemInstalledFontRecord],
    registry_count: usize,
    folder_count: usize,
    elapsed_ms: u128,
) -> Result<String, String> {
    serde_json::to_string(&json!({
        "ok": true,
        "items": items,
        "count": items.len(),
        "registryCount": registry_count,
        "folderCount": folder_count,
        "elapsedMs": elapsed_ms,
        "workerMode": "rust-system-installed-fonts"
    }))
    .map_err(|error| error.to_string())
}
