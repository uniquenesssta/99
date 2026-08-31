use serde_json::Value;

fn text_field(font: &Value, field: &str) -> String {
    font.get(field).and_then(Value::as_str).unwrap_or("").to_string()
}

fn string_array(font: &Value, field: &str) -> Vec<String> {
    match font.get(field) {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(|text| text.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

pub fn infer_font_search_category(font: &Value) -> &'static str {
    let mut text = String::new();
    for field in ["fileName", "path", "family", "fullName", "postscriptName", "style"] {
        text.push_str(&text_field(font, field));
        text.push(' ');
    }
    for tag in string_array(font, "tagNames") {
        text.push_str(&tag);
        text.push(' ');
    }
    let text = text.to_lowercase();

    if contains_any(&text, &["mono", "monospace", "code", "console", "consola", "courier", "等宽", "等寬"]) {
        return "monospace";
    }
    if contains_any(&text, &["handwriting", "handwritten", "marker", "brush", "calligraphy", "手写", "手寫", "马克笔", "麥克筆"]) {
        return "handwriting";
    }
    if contains_any(&text, &["script", "cursive", "sign", "signature", "swash", "草书", "草書", "行书", "行書", "连笔", "連筆"]) {
        return "script";
    }
    if contains_any(&text, &["slab", "egyptian", "rockwell", "clarendon", "粗衬线", "粗襯線"]) {
        return "slabSerif";
    }
    if contains_any(&text, &["黑体", "黑體", "雅黑", "heiti", "hei", "gothic", "sans cjk", "source han sans", "noto sans cjk", "思源黑", "苹方", "蘋方"]) {
        return "hei";
    }
    if contains_any(&text, &["serif", "song", "sung", "mincho", "ming", "宋体", "宋體", "明体", "明體", "明朝", "思源宋", "source han serif", "noto serif cjk", "times", "georgia"]) {
        return "serif";
    }
    if contains_any(&text, &["display", "decorative", "poster", "headline", "banner", "art", "pop", "title", "装饰", "裝飾", "海报", "海報", "标题", "標題", "综艺", "綜藝"]) {
        return "art";
    }
    if contains_any(&text, &["sans", "gothic", "ui", "arial", "helvetica", "calibri", "verdana", "tahoma", "无衬线", "無襯線"]) {
        return "sansSerif";
    }
    "sansSerif"
}
