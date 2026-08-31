use std::fs;
use std::path::Path;

use crate::config::ListFontFilesConfig;
use crate::json::escape_json;
use crate::scanner::{list_font_files, result_to_json};
use crate::scanner::parse_batch::{parse_font_batch, FontParseBatchCommandConfig};

pub fn run_daemon_list_font_files(config: &ListFontFilesConfig) -> Result<String, String> {
    let result = list_font_files(
        Path::new(&config.root),
        &config.extensions,
        config.max_entries,
        config.probe_names,
        config.probe_scripts,
        config.probe_style,
        config.probe_family,
        config.full_hash,
    );
    let payload = result_to_json(&config.root, &result);
    if let Some(output_path) = &config.output {
        fs::write(output_path, payload).map_err(|error| error.to_string())?;
        Ok("{\"ok\":true,\"written\":true,\"workerMode\":\"rust-core-daemon-scan-listing\"}".to_string())
    } else {
        Ok(payload)
    }
}

pub fn run_daemon_font_parse_batch(config: &FontParseBatchCommandConfig) -> Result<String, String> {
    parse_font_batch(config).map(|json| {
        if json.contains("\"workerMode\":") {
            json
        } else {
            format!(
                "{{\"ok\":false,\"message\":\"{}\",\"workerMode\":\"rust-core-daemon-font-parse-batch\"}}",
                escape_json("unexpected rust parse batch payload")
            )
        }
    })
}
