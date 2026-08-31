use crate::family::FontFamilyHint;
use crate::font_parser::{FontNameInfo, FontScriptInfo, FontStyleInfo};
use crate::json::escape_json;
use crate::protocol::{PROTOCOL_VERSION, WORKER_NAME, WORKER_VERSION};

use super::types::ListFontFilesResult;

fn optional_string_json(name: &str, value: &Option<String>) -> String {
    match value {
        Some(text) => format!(",\"{}\":\"{}\"", name, escape_json(text)),
        None => String::new(),
    }
}

fn name_hint_to_json(info: &FontNameInfo) -> String {
    let mut output = String::new();
    output.push_str(",\"nameHint\":{");
    output.push_str(&format!("\"recordCount\":{},\"sourceIndex\":{}", info.record_count, info.source_index));
    output.push_str(&optional_string_json("familyName", &info.family_name));
    output.push_str(&optional_string_json("subfamilyName", &info.subfamily_name));
    output.push_str(&optional_string_json("fullName", &info.full_name));
    output.push_str(&optional_string_json("postscriptName", &info.postscript_name));
    output.push_str(&optional_string_json("preferredFamily", &info.preferred_family));
    output.push_str(&optional_string_json("preferredSubfamily", &info.preferred_subfamily));
    output.push_str(&optional_string_json("version", &info.version));
    output.push_str(&optional_string_json("manufacturer", &info.manufacturer));
    if let Some(display_family) = info.display_family() {
        output.push_str(&format!(",\"displayFamily\":\"{}\"", escape_json(&display_family)));
    }
    if let Some(display_subfamily) = info.display_subfamily() {
        output.push_str(&format!(",\"displaySubfamily\":\"{}\"", escape_json(&display_subfamily)));
    }
    output.push('}');
    output
}

fn script_hint_to_json(info: &FontScriptInfo) -> String {
    let mut output = String::new();
    output.push_str(",\"scriptHint\":{");
    output.push_str(&format!("\"rangeCount\":{},\"sourceIndex\":{},\"scripts\":[", info.range_count, info.source_index));
    for (index, script) in info.scripts.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&format!("\"{}\"", escape_json(script)));
    }
    output.push_str("]}");
    output
}


fn style_hint_to_json(info: &FontStyleInfo) -> String {
    let mut output = String::new();
    output.push_str(",\"styleHint\":{");
    output.push_str(&format!("\"sourceIndex\":{}", info.source_index));
    if let Some(weight_class) = info.weight_class {
        output.push_str(&format!(",\"weightClass\":{}", weight_class));
    }
    if let Some(width_class) = info.width_class {
        output.push_str(&format!(",\"widthClass\":{}", width_class));
    }
    output.push_str(&format!(",\"italic\":{}", if info.italic { "true" } else { "false" }));
    output.push_str(&format!(",\"bold\":{}", if info.bold { "true" } else { "false" }));
    if let Some(monospaced) = info.monospaced {
        output.push_str(&format!(",\"monospaced\":{}", if monospaced { "true" } else { "false" }));
    }
    if let Some(units_per_em) = info.units_per_em {
        output.push_str(&format!(",\"unitsPerEm\":{}", units_per_em));
    }
    if let Some(glyph_count) = info.glyph_count {
        output.push_str(&format!(",\"glyphCount\":{}", glyph_count));
    }
    output.push('}');
    output
}

fn family_hint_to_json(info: &FontFamilyHint) -> String {
    let mut output = String::new();
    output.push_str(",\"familyHint\":{");
    output.push_str(&format!("\"familyName\":\"{}\",\"styleName\":\"{}\",\"familyKey\":\"{}\",\"styleKey\":\"{}\",\"sourceIndex\":{}",
        escape_json(&info.family_name),
        escape_json(&info.style_name),
        escape_json(&info.family_key),
        escape_json(&info.style_key),
        info.source_index
    ));
    if let Some(weight_class) = info.weight_class {
        output.push_str(&format!(",\"weightClass\":{}", weight_class));
    }
    if let Some(width_class) = info.width_class {
        output.push_str(&format!(",\"widthClass\":{}", width_class));
    }
    output.push_str(&format!(",\"italic\":{}", if info.italic { "true" } else { "false" }));
    output.push_str(&format!(",\"bold\":{}", if info.bold { "true" } else { "false" }));
    if let Some(monospaced) = info.monospaced {
        output.push_str(&format!(",\"monospaced\":{}", if monospaced { "true" } else { "false" }));
    }
    output.push('}');
    output
}

fn estimated_json_capacity(result: &ListFontFilesResult) -> usize {
    512
        + result.files.len().saturating_mul(512)
        + result.directories.len().saturating_mul(160)
        + result.errors.len().saturating_mul(160)
}


pub fn result_to_json(root: &str, result: &ListFontFilesResult) -> String {
    let mut output = String::with_capacity(estimated_json_capacity(result));
    output.push_str(&format!(
        "{{\"ok\":true,\"name\":\"{}\",\"version\":\"{}\",\"protocolVersion\":{},\"root\":\"{}\",\"truncated\":{},\"count\":{},\"foldersScanned\":{},\"files\":[",
        WORKER_NAME,
        WORKER_VERSION,
        PROTOCOL_VERSION,
        escape_json(root),
        if result.truncated { "true" } else { "false" },
        result.files.len(),
        result.directories.len()
    ));

    for (index, entry) in result.files.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&format!(
            "{{\"path\":\"{}\",\"size\":{},\"modifiedMs\":{},\"createdMs\":{},\"changedMs\":{},\"signatureValid\":{},\"format\":\"{}\",\"quickHash\":\"{}\",\"contentHash\":\"{}\",\"hashKind\":\"{}\"",
            escape_json(&entry.path),
            entry.size,
            entry.modified_ms,
            entry.created_ms,
            entry.changed_ms,
            if entry.signature_valid { "true" } else { "false" },
            escape_json(&entry.format),
            escape_json(&entry.quick_hash),
            escape_json(&entry.content_hash),
            escape_json(&entry.hash_kind)
        ));
        if let Some(name_hint) = &entry.name_hint {
            output.push_str(&name_hint_to_json(name_hint));
        }
        if let Some(script_hint) = &entry.script_hint {
            output.push_str(&script_hint_to_json(script_hint));
        }
        if let Some(style_hint) = &entry.style_hint {
            output.push_str(&style_hint_to_json(style_hint));
        }
        if let Some(family_hint) = &entry.family_hint {
            output.push_str(&family_hint_to_json(family_hint));
        }
        output.push('}');
    }

    output.push_str("],\"directories\":[");
    for (index, entry) in result.directories.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&format!(
            "{{\"path\":\"{}\",\"modifiedMs\":{},\"fileCount\":{},\"dirCount\":{}}}",
            escape_json(&entry.path),
            entry.modified_ms,
            entry.file_count,
            entry.dir_count
        ));
    }

    output.push_str("],\"errors\":[");
    for (index, (path, message)) in result.errors.iter().enumerate() {
        if index > 0 {
            output.push(',');
        }
        output.push_str(&format!(
            "{{\"path\":\"{}\",\"message\":\"{}\"}}",
            escape_json(path),
            escape_json(message)
        ));
    }
    output.push_str("]}");
    output
}
