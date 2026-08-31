use std::collections::BTreeMap;
use std::time::Instant;

use super::directory::read_folder_installed_fonts;
use super::name_candidates::installed_font_name_candidates;
use super::output::system_installed_fonts_json;
use super::registry::read_registry_installed_fonts;
use super::types::{SystemInstalledFontsConfig, SystemInstalledFontsResult};

fn dedup_key(source: &str, registry_name: &str, value: &str) -> String {
    format!("{}|{}|{}", source, registry_name, value).to_lowercase()
}

pub fn read_system_installed_fonts(config: &SystemInstalledFontsConfig) -> Result<SystemInstalledFontsResult, String> {
    let started_at = Instant::now();
    let registry_items = read_registry_installed_fonts(&config.windows_fonts_dir);
    let folder_items = read_folder_installed_fonts(
        &config.windows_fonts_dir,
        &config.current_user_fonts_dir,
        &config.extensions,
    );
    let registry_count = registry_items.len();
    let folder_count = folder_items.len();

    let mut merged = BTreeMap::new();
    for item in registry_items.into_iter().chain(folder_items.into_iter()) {
        merged.insert(dedup_key(&item.source, &item.registry_name, &item.value), item);
    }

    let mut items = merged.into_values().collect::<Vec<_>>();
    if config.include_name_candidates {
        for item in &mut items {
            if let Some(path) = item.path.as_ref() {
                item.name_candidates = installed_font_name_candidates(path);
            }
        }
    }

    let json = system_installed_fonts_json(&items, registry_count, folder_count, started_at.elapsed().as_millis())?;
    Ok(SystemInstalledFontsResult { json })
}
