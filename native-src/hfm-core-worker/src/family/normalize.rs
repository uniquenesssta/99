use crate::font_parser::{FontNameInfo, FontStyleInfo};

use super::types::FontFamilyHint;

const STYLE_SUFFIX_WORDS: &[&str] = &[
    "thin", "extralight", "ultralight", "light", "regular", "normal", "book", "roman",
    "medium", "semibold", "demibold", "bold", "extrabold", "ultrabold", "black", "heavy",
    "italic", "oblique", "condensed", "narrow", "expanded", "常规", "標準", "标准", "粗体", "粗體", "细体", "細體", "中黑", "中等", "斜体", "斜體",
];

fn collapse_spaces(value: &str) -> String {
    value
        .split(|ch: char| ch.is_whitespace() || ch == '_' || ch == '-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn normalize_key(value: &str) -> String {
    collapse_spaces(value)
        .chars()
        .filter(|ch| *ch != '\u{200b}' && *ch != '\u{200c}' && *ch != '\u{200d}' && *ch != '\u{feff}')
        .collect::<String>()
        .to_lowercase()
}

fn strip_style_suffix(value: &str) -> String {
    let collapsed = collapse_spaces(value);
    let mut parts: Vec<&str> = collapsed.split(' ').filter(|part| !part.is_empty()).collect();
    for _ in 0..3 {
        let Some(last) = parts.last() else {
            break;
        };
        let last_lowered = last.to_lowercase();
        if parts.len() > 1 && STYLE_SUFFIX_WORDS.iter().any(|word| word.to_lowercase() == last_lowered) {
            parts.pop();
        } else {
            break;
        }
    }
    let stripped = parts.join(" ").trim().to_string();
    if stripped.is_empty() {
        collapsed
    } else {
        stripped
    }
}


fn style_from_hint(style: Option<&FontStyleInfo>, fallback: &str) -> String {
    let fallback = collapse_spaces(fallback);
    if !fallback.is_empty() {
        return fallback;
    }

    let Some(style) = style else {
        return "Regular".to_string();
    };

    let mut parts: Vec<&str> = Vec::new();
    if let Some(width) = style.width_class {
        if width <= 4 {
            parts.push("Condensed");
        } else if width >= 6 {
            parts.push("Expanded");
        }
    }
    if let Some(weight) = style.weight_class {
        if weight <= 250 {
            parts.push("Thin");
        } else if weight <= 350 {
            parts.push("Light");
        } else if weight >= 850 {
            parts.push("Black");
        } else if weight >= 700 || style.bold {
            parts.push("Bold");
        } else if weight >= 500 {
            parts.push("Medium");
        }
    } else if style.bold {
        parts.push("Bold");
    }
    if style.italic {
        parts.push("Italic");
    }
    if parts.is_empty() {
        "Regular".to_string()
    } else {
        parts.join(" ")
    }
}

pub fn derive_family_hint(name: &FontNameInfo, style: Option<&FontStyleInfo>) -> Option<FontFamilyHint> {
    let raw_family = name
        .display_family()
        .or_else(|| name.full_name.clone())
        .or_else(|| name.postscript_name.clone())
        .unwrap_or_default();
    let style_name = style_from_hint(style, &name.display_subfamily().unwrap_or_default());
    let family_name = strip_style_suffix(&raw_family);
    let family_key = normalize_key(&family_name);
    if family_key.is_empty() {
        return None;
    }
    let style_key = normalize_key(&style_name);
    let info = FontFamilyHint {
        family_name,
        style_name,
        family_key,
        style_key,
        weight_class: style.and_then(|value| value.weight_class),
        width_class: style.and_then(|value| value.width_class),
        italic: style.map(|value| value.italic).unwrap_or(false),
        bold: style.map(|value| value.bold).unwrap_or(false),
        monospaced: style.and_then(|value| value.monospaced),
        source_index: name.source_index,
    };
    if info.is_usable() { Some(info) } else { None }
}
