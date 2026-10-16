use std::fs::File;
use super::diagnostics::{record, record_io, MetadataDiagnostic, MetadataDiagnosticKind as Kind};
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
    pub diagnostics: Vec<MetadataDiagnostic>,
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

    let mut info = FontMetadataInfo::default();
    let offsets = match font_offsets(file, &mut info.diagnostics) {
        Ok(offsets) => offsets,
        Err(error) => { record_io(&mut info.diagnostics, "collection", None, &error); return info; },
    };

    if offsets.is_empty() { record(&mut info.diagnostics, "collection", Kind::EmptyMetadata, None, "no-faces"); }
    for (index, offset) in offsets.into_iter().enumerate() {
        let table_directory = match read_font_table_directory(file, offset, index, &mut info.diagnostics) {
            Ok(Some(table_directory)) => table_directory,
            Ok(None) => continue,
            Err(error) => { record_io(&mut info.diagnostics, "table-directory", Some(index), &error); continue; },
        };

        if wants_name && info.name_hint.is_none() {
            match probe_font_names_from_directory(file, &table_directory, index, &mut info.diagnostics) {
                Ok(hint) => info.name_hint = hint,
                Err(error) => record_io(&mut info.diagnostics, "name", Some(index), &error),
            }
        }
        if options.probe_scripts && info.script_hint.is_none() {
            match probe_font_scripts_from_directory(file, &table_directory, index, &mut info.diagnostics) {
                Ok(hint) => info.script_hint = hint,
                Err(error) => record_io(&mut info.diagnostics, "cmap", Some(index), &error),
            }
        }
        if wants_style && info.style_hint.is_none() {
            match probe_font_style_from_directory(file, &table_directory, index) {
                Ok(hint) => info.style_hint = hint,
                Err(error) => record_io(&mut info.diagnostics, "style", Some(index), &error),
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

