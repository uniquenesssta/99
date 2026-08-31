use std::path::Path;

pub fn has_font_extension(path: &Path, extensions: &[String]) -> bool {
    let Some(ext) = path.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    let ext = ext.to_ascii_lowercase();
    extensions.iter().any(|candidate| candidate == &ext)
}

pub fn should_skip_directory_name(name: &str) -> bool {
    if name == "node_modules" || name.starts_with('.') {
        return true;
    }
    matches!(
        name,
        ".hfm-cache"
            | ".hfm-preview-cache"
            | "preview-cache"
            | "Cache"
            | "Code Cache"
            | "GPUCache"
            | "DawnGraphiteCache"
            | "DawnWebGPUCache"
            | "Local Storage"
            | "Session Storage"
            | "SharedStorage"
            | "Shared Dictionary"
            | "blob_storage"
            | "Network"
    )
}
