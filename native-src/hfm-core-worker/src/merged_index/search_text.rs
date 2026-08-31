use std::collections::BTreeSet;

use serde_json::Value;

use super::category::infer_font_search_category;

fn text_field(font: &Value, field: &str) -> String {
    font.get(field).and_then(Value::as_str).unwrap_or("").trim().to_string()
}

fn string_array(font: &Value, field: &str) -> Vec<String> {
    match font.get(field) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn normalize_format(value: &str) -> String {
    let raw = value.trim().to_lowercase();
    if raw == "ttf" || raw.contains("truetype") {
        return "ttf".to_string();
    }
    if raw == "otf" || raw.contains("opentype") {
        return "otf".to_string();
    }
    if raw == "ttc" {
        return "ttc".to_string();
    }
    if raw == "otc" {
        return "otc".to_string();
    }
    if raw.is_empty() {
        "unknown".to_string()
    } else {
        raw
    }
}

fn script_label(script: &str) -> &'static str {
    match script {
        "chinese" => "中文",
        "latin" => "英文 西文",
        "japanese" => "日文",
        "korean" => "韩文",
        "symbol" => "符号",
        "other" => "其他语言",
        "arabic" => "阿拉伯文",
        "hebrew" => "希伯来文",
        "thai" => "泰文",
        "cyrillic" => "西里尔文",
        "greek" => "希腊文",
        "devanagari" => "天城文",
        "bengali" => "孟加拉文",
        "tamil" => "泰米尔文",
        "telugu" => "泰卢固文",
        "gujarati" => "古吉拉特文",
        "gurmukhi" => "古尔穆基文",
        "lao" => "老挝文",
        "khmer" => "高棉文",
        "myanmar" => "缅甸文",
        "ethiopic" => "埃塞俄比亚文",
        "armenian" => "亚美尼亚文",
        "georgian" => "格鲁吉亚文",
        "vietnamese" => "越南文",
        _ => "",
    }
}

fn category_label(category: &str) -> &'static str {
    match category {
        "serif" => "衬线 宋体 明体",
        "slabSerif" => "粗衬线",
        "sansSerif" => "无衬线 黑体",
        "script" => "连笔 草书 花体",
        "monospace" => "等宽 代码",
        "handwriting" => "手写",
        "hei" => "黑体",
        "art" => "艺术 装饰 标题 海报",
        _ => "",
    }
}

fn push_part(parts: &mut Vec<String>, value: impl AsRef<str>) {
    let clean = value.as_ref().trim();
    if !clean.is_empty() {
        parts.push(clean.to_string());
    }
}

fn bool_field(font: &Value, field: &str) -> bool {
    font.get(field).and_then(Value::as_bool).unwrap_or(false)
}

pub fn build_search_text(font_json: Option<&str>, root_path: &str, relative_path: &str, category_hint: Option<&str>) -> String {
    let mut parts = Vec::new();
    let parsed = font_json.and_then(|raw| serde_json::from_str::<Value>(raw).ok());
    if let Some(font) = parsed.as_ref() {
        for field in ["fileName", "family", "fullName", "postscriptName", "style", "path"] {
            push_part(&mut parts, text_field(font, field));
        }
        push_part(&mut parts, root_path);
        push_part(&mut parts, relative_path);
        let format = normalize_format(&text_field(font, "format"));
        push_part(&mut parts, &format);
        push_part(&mut parts, format.to_uppercase());
        let category = category_hint.unwrap_or_else(|| infer_font_search_category(font));
        push_part(&mut parts, category);
        push_part(&mut parts, category_label(category));
        for script in string_array(font, "scripts") {
            push_part(&mut parts, &script);
            push_part(&mut parts, script_label(&script));
        }
        for tag in string_array(font, "tagNames") {
            push_part(&mut parts, tag);
        }
        for collection_id in string_array(font, "collectionIds") {
            push_part(&mut parts, collection_id);
        }
        if bool_field(font, "systemInstalled") {
            push_part(&mut parts, "已安装 installed system");
        } else {
            push_part(&mut parts, "未安装 not installed");
        }
        if bool_field(font, "deleteProtected") {
            push_part(&mut parts, "保护 不可删除 删除保护 protected");
        }
        if bool_field(font, "systemImported") {
            push_part(&mut parts, "系统字体 system font");
        }
    } else {
        push_part(&mut parts, root_path);
        push_part(&mut parts, relative_path);
    }

    let mut seen = BTreeSet::new();
    let mut deduped = Vec::new();
    for part in parts {
        let clean = part.trim().to_lowercase();
        if !clean.is_empty() && seen.insert(clean.clone()) {
            deduped.push(clean);
        }
    }
    deduped.join(" ")
}
