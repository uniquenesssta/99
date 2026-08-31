use std::fs::File;
use crate::family::{derive_family_hint, FontFamilyHint};

use super::name_table::probe_font_names_from_directory;
use super::scripts::probe_font_scripts_from_directory;
use super::style::probe_font_style_from_directory;
use super::table_directory::read_font_table_directory;
use super::ttc::font_offsets;
use super::types::{FontNameInfo, FontScriptInfo, FontStyleInfo};

#[derive(Clone, Debug, Default)]
pub struct FontMetadataProbeOptions {
    pub probe_names: bool,
    pub probe_scripts: bool,
    pub probe_style: bool,
    pub probe_family: bool,
}

#[derive(Clone, Debug, Default)]
pub struct FontMetadataInfo {
    pub name_hint: Option<FontNameInfo>,
    pub script_hint: Option<FontScriptInfo>,
    pub style_hint: Option<FontStyleInfo>,
    pub family_hint: Option<FontFamilyHint>,
}

impl FontMetadataInfo {
    fn has_all_requested(&self, options: &FontMetadataProbeOptions) -> bool {
        let wants_name = options.probe_names || options.probe_family;
        let wants_style = options.probe_style || options.probe_family;
        (!wants_name || self.name_hint.is_some())
            && (!options.probe_scripts || self.script_hint.is_some())
            && (!wants_style || self.style_hint.is_some())
    }
}

pub fn probe_font_metadata_from_file(file: &mut File, options: &FontMetadataProbeOptions) -> FontMetadataInfo {
    let wants_name = options.probe_names || options.probe_family;
    let wants_style = options.probe_style || options.probe_family;
    if !wants_name && !options.probe_scripts && !wants_style {
        return FontMetadataInfo::default();
    }

    let offsets = match font_offsets(file) {
        Ok(offsets) => offsets,
        Err(_) => return FontMetadataInfo::default(),
    };

    let mut info = FontMetadataInfo::default();
    for (index, offset) in offsets.into_iter().enumerate() {
        let table_directory = match read_font_table_directory(file, offset) {
            Ok(Some(table_directory)) => table_directory,
            _ => continue,
        };

        if wants_name && info.name_hint.is_none() {
            if let Ok(Some(name_hint)) = probe_font_names_from_directory(file, &table_directory, index) {
                info.name_hint = Some(name_hint);
            }
        }
        if options.probe_scripts && info.script_hint.is_none() {
            if let Ok(Some(script_hint)) = probe_font_scripts_from_directory(file, &table_directory, index) {
                info.script_hint = Some(script_hint);
            }
        }
        if wants_style && info.style_hint.is_none() {
            if let Ok(Some(style_hint)) = probe_font_style_from_directory(file, &table_directory, index) {
                info.style_hint = Some(style_hint);
            }
        }
        if info.has_all_requested(options) {
            break;
        }
    }

    if options.probe_family {
        info.family_hint = info
            .name_hint
            .as_ref()
            .and_then(|name| derive_family_hint(name, info.style_hint.as_ref()));
    }

    info
}

