use std::collections::BTreeSet;
use std::fs::File;

use crate::font_parser::{probe_font_metadata_from_file, FontMetadataProbeOptions};

use super::normalize::{is_usable_installed_name_candidate, normalize_compare_text, path_file_name, path_file_stem};

fn push_candidate(set: &mut BTreeSet<String>, value: Option<String>) {
    let Some(value) = value else { return };
    let normalized = normalize_compare_text(&value);
    if is_usable_installed_name_candidate(&normalized) {
        set.insert(normalized);
    }
}

pub fn installed_font_name_candidates(path: &str) -> Vec<String> {
    let mut set = BTreeSet::new();
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(_) => {
            push_candidate(&mut set, path_file_stem(path));
            push_candidate(&mut set, path_file_name(path));
            return set.into_iter().collect();
        }
    };

    let metadata = probe_font_metadata_from_file(
        &mut file,
        &FontMetadataProbeOptions {
            probe_names: true,
            probe_scripts: false,
            probe_style: false,
            probe_family: false,
        },
    );

    if let Some(name) = metadata.name_hint {
        let display_family = name.display_family();
        let display_subfamily = name.display_subfamily();
        push_candidate(&mut set, name.family_name);
        push_candidate(&mut set, name.full_name);
        push_candidate(&mut set, name.postscript_name);
        push_candidate(&mut set, name.subfamily_name);
        push_candidate(&mut set, name.preferred_family);
        push_candidate(&mut set, name.preferred_subfamily);
        push_candidate(&mut set, display_family);
        push_candidate(&mut set, display_subfamily);
    }
    push_candidate(&mut set, path_file_stem(path));
    push_candidate(&mut set, path_file_name(path));
    set.into_iter().collect()
}
