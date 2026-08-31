use std::fs::{File, Metadata};
use std::io;
use std::path::Path;

use crate::font_parser::{probe_font_metadata_from_file, FontMetadataProbeOptions};
use crate::font_probe::probe_font_signature_from_file;
use crate::hash::{full_file_fingerprint_from_file, quick_file_fingerprint_from_file};

use super::metadata::timestamp_ms;
use super::types::FontFileEntry;

#[derive(Clone, Debug, Default)]
pub struct FontFileScanOptions {
    pub probe_names: bool,
    pub probe_scripts: bool,
    pub probe_style: bool,
    pub probe_family: bool,
    pub full_hash: bool,
}

impl FontFileScanOptions {
    pub fn metadata_options(&self) -> FontMetadataProbeOptions {
        FontMetadataProbeOptions {
            probe_names: self.probe_names,
            probe_scripts: self.probe_scripts,
            probe_style: self.probe_style,
            probe_family: self.probe_family,
        }
    }
}

pub fn scan_font_file(path: &Path, metadata: &Metadata, options: &FontFileScanOptions) -> io::Result<FontFileEntry> {
    let mut file = File::open(path)?;
    let modified_ms = metadata.modified().map(timestamp_ms).unwrap_or(0);
    let created_ms = metadata.created().map(timestamp_ms).unwrap_or(0);
    let size = metadata.len();
    let probe = probe_font_signature_from_file(&mut file);
    let quick_hash = quick_file_fingerprint_from_file(&mut file, size).unwrap_or_default();
    let content_hash = if options.full_hash {
        full_file_fingerprint_from_file(&mut file, size).unwrap_or_else(|_| quick_hash.clone())
    } else {
        quick_hash.clone()
    };
    let hash_kind = if options.full_hash { "full-fnv1a64" } else { "quick-fnv1a64" }.to_string();
    let metadata_hint = if probe.valid_signature {
        probe_font_metadata_from_file(&mut file, &options.metadata_options())
    } else {
        Default::default()
    };

    Ok(FontFileEntry {
        path: path.to_string_lossy().to_string(),
        size,
        modified_ms,
        created_ms,
        changed_ms: modified_ms,
        signature_valid: probe.valid_signature,
        format: probe.format,
        quick_hash,
        content_hash,
        hash_kind,
        name_hint: metadata_hint.name_hint,
        script_hint: metadata_hint.script_hint,
        style_hint: metadata_hint.style_hint,
        family_hint: metadata_hint.family_hint,
    })
}
