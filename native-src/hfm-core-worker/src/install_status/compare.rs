use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::types::{InstallStatusCommandConfig, InstallStatusCompareResult};

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InstallStatusComparePayload {
    #[serde(default)]
    app_name: String,
    #[serde(default)]
    items: Vec<InstallStatusCompareFontItem>,
    #[serde(default)]
    installed: Vec<SystemInstalledFontRecord>,
}

#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct InstallStatusCompareFontItem {
    id: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    file_name: String,
    #[serde(default)]
    family: String,
    #[serde(default)]
    full_name: String,
    #[serde(default)]
    postscript_name: String,
    #[serde(default)]
    managed_install_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct SystemInstalledFontRecord {
    #[serde(default)]
    source: String,
    #[serde(default)]
    registry_name: String,
    #[serde(default)]
    value: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    path: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    file_name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    name_candidates: Vec<String>,
}

#[derive(Clone, Debug)]
struct PreparedInstalledFontRecord {
    record: SystemInstalledFontRecord,
    normalized_path: String,
    file_name: String,
    normalized_registry_name: String,
    name_candidates: Vec<String>,
    temporary_active: bool,
}

#[derive(Clone, Debug, Default)]
struct InstalledFontLookupIndex {
    records: Vec<PreparedInstalledFontRecord>,
    path_map: BTreeMap<String, Vec<usize>>,
    file_map: BTreeMap<String, Vec<usize>>,
    registry_map: BTreeMap<String, Vec<usize>>,
    candidate_map: BTreeMap<String, Vec<usize>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallStatusCompareOutput {
    ok: bool,
    results: BTreeMap<String, InstallStatusCompareResult>,
    count: usize,
    elapsed_ms: u128,
    worker_mode: &'static str,
}

pub fn compare_install_status(config: &InstallStatusCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: InstallStatusComparePayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let app_name = if payload.app_name.trim().is_empty() { "字体管理器".to_string() } else { payload.app_name };
    let lookup = build_installed_font_lookup_index(&payload.installed, &app_name);
    let mut results = BTreeMap::new();

    for item in payload.items.iter() {
        if item.id.trim().is_empty() {
            continue;
        }
        results.insert(item.id.clone(), compare_font_installed_with_lookup_index(item, &lookup, &app_name));
    }

    let output = InstallStatusCompareOutput {
        ok: true,
        count: results.len(),
        results,
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-install-status-compare",
    };
    serde_json::to_string(&output).map_err(|error| error.to_string())
}

fn add_index(map: &mut BTreeMap<String, Vec<usize>>, key: String, index: usize) {
    if key.is_empty() {
        return;
    }
    map.entry(key).or_default().push(index);
}

fn build_installed_font_lookup_index(installed: &[SystemInstalledFontRecord], app_name: &str) -> InstalledFontLookupIndex {
    let mut lookup = InstalledFontLookupIndex::default();

    for record in installed.iter().cloned() {
        let file_name = clean_font_file_name(first_non_empty(&[&record.file_name, &record.path, &record.value]));
        let prepared = PreparedInstalledFontRecord {
            normalized_path: normalize_installed_path(first_non_empty(&[&record.path, &record.value])),
            file_name: file_name.clone(),
            normalized_registry_name: normalize_compare_text(&record.registry_name),
            name_candidates: compare_name_candidates_for_installed_record(&record),
            temporary_active: is_temporary_active_installed_record(&record, app_name),
            record,
        };
        let index = lookup.records.len();
        add_index(&mut lookup.path_map, prepared.normalized_path.clone(), index);
        add_index(&mut lookup.file_map, prepared.file_name.clone(), index);
        add_index(&mut lookup.registry_map, prepared.normalized_registry_name.clone(), index);
        for candidate in &prepared.name_candidates {
            add_index(&mut lookup.candidate_map, candidate.clone(), index);
        }
        lookup.records.push(prepared);
    }

    lookup
}

fn compare_font_installed_with_lookup_index(item: &InstallStatusCompareFontItem, lookup: &InstalledFontLookupIndex, app_name: &str) -> InstallStatusCompareResult {
    let mut seen = BTreeSet::new();
    let mut matches: Vec<SystemInstalledFontRecord> = Vec::new();

    add_matches(&mut seen, &mut matches, lookup, lookup.path_map.get(&normalize_installed_path(&item.path)), None, item, app_name);
    add_matches(&mut seen, &mut matches, lookup, lookup.path_map.get(&normalize_installed_path(&item.managed_install_path)), Some(|row, item, app_name| installed_record_matches_managed_item(item, &row.record, app_name)), item, app_name);
    add_matches(&mut seen, &mut matches, lookup, lookup.file_map.get(&clean_font_file_name(&safe_managed_font_name(item, app_name))), Some(|row, item, app_name| installed_record_matches_managed_item(item, &row.record, app_name)), item, app_name);
    add_matches(&mut seen, &mut matches, lookup, lookup.file_map.get(&clean_font_file_name(first_non_empty(&[&item.file_name, &item.path]))), None, item, app_name);
    add_matches(&mut seen, &mut matches, lookup, lookup.registry_map.get(&normalize_compare_text(&registry_name_for(item))), None, item, app_name);

    for candidate in compare_name_candidates_for_font(item) {
        add_matches(&mut seen, &mut matches, lookup, lookup.candidate_map.get(&candidate), None, item, app_name);
    }

    let managed = matches.iter().any(|record| installed_record_matches_managed_item(item, record, app_name));
    let system = matches.iter().any(is_system_installed_record);
    let user = matches.iter().any(|record| !installed_record_matches_managed_item(item, record, app_name) && !is_system_installed_record(record));
    let by = if managed && system { "both" } else if managed { "managed" } else if system { "system" } else if user { "user" } else { "none" };

    InstallStatusCompareResult {
        installed: managed || system || user,
        by: by.to_string(),
        matches: serde_json::to_value(matches).unwrap_or_else(|_| Value::Array(Vec::new())),
    }
}

fn add_matches(
    seen: &mut BTreeSet<String>,
    matches: &mut Vec<SystemInstalledFontRecord>,
    lookup: &InstalledFontLookupIndex,
    indexes: Option<&Vec<usize>>,
    predicate: Option<fn(&PreparedInstalledFontRecord, &InstallStatusCompareFontItem, &str) -> bool>,
    item: &InstallStatusCompareFontItem,
    app_name: &str,
) {
    let Some(indexes) = indexes else { return; };
    for index in indexes {
        let Some(row) = lookup.records.get(*index) else { continue; };
        if row.temporary_active {
            continue;
        }
        if let Some(predicate) = predicate {
            if !predicate(row, item, app_name) {
                continue;
            }
        }
        let key = format!("{}|{}|{}|{}", row.record.source, row.record.registry_name, row.record.value, row.record.path);
        if !seen.insert(key) {
            continue;
        }
        matches.push(row.record.clone());
    }
}

fn first_non_empty<'a>(values: &[&'a str]) -> &'a str {
    for value in values {
        if !value.trim().is_empty() {
            return value;
        }
    }
    ""
}

fn safe_managed_font_name(item: &InstallStatusCompareFontItem, app_name: &str) -> String {
    if !item.managed_install_path.trim().is_empty() {
        return file_name_from_path(&item.managed_install_path);
    }
    let stem = file_stem(first_non_empty(&[&item.file_name, &item.path]));
    let clean_stem = clean_file_stem(&stem, 80);
    let ext = extension_lower(first_non_empty(&[&item.file_name, &item.path]));
    let short_id = item.id.chars().take(12).collect::<String>();
    format!("{}_{}_{}{}", app_name, short_id, if clean_stem.is_empty() { "font" } else { &clean_stem }, ext)
}

fn registry_name_for(item: &InstallStatusCompareFontItem) -> String {
    let ext = extension_lower(first_non_empty(&[&item.file_name, &item.path]));
    let type_name = if ext == ".otf" || ext == ".otc" { "OpenType" } else { "TrueType" };
    let stem = file_stem(first_non_empty(&[&item.file_name, &item.path]));
    let name = if !item.full_name.trim().is_empty() {
        item.full_name.clone()
    } else if !item.family.trim().is_empty() {
        item.family.clone()
    } else {
        stem
    };
    format!("{} ({})", name, type_name)
}

fn normalize_compare_text(input: &str) -> String {
    let mut lower = input.to_lowercase();
    for token in ["(truetype)", "(opentype)", "truetype", "opentype", "regular", "bold", "italic", "字体", "常规", "粗体", "斜体"] {
        lower = lower.replace(token, "");
    }
    lower
        .chars()
        .filter(|ch| ch.is_alphanumeric() || is_cjk(*ch))
        .collect::<String>()
}

fn is_cjk(ch: char) -> bool {
    ('\u{4e00}'..='\u{9fa5}').contains(&ch)
}

fn is_usable_installed_name_candidate(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }
    value.chars().count() >= 6 || (value.chars().count() >= 2 && value.chars().any(is_cjk))
}

fn normalize_installed_path(value: &str) -> String {
    value.trim_matches('"').replace('/', "\\").to_lowercase()
}

fn is_temporary_active_installed_record(record: &SystemInstalledFontRecord, app_name: &str) -> bool {
    let file_name = clean_font_file_name(first_non_empty(&[&record.file_name, &record.path, &record.value]));
    let registry_name = record.registry_name.to_lowercase();
    let prefix = app_name.to_lowercase();
    file_name.starts_with(&format!("{}_active_", prefix)) || registry_name.starts_with(&format!("{} active ", prefix))
}

fn installed_record_matches_managed_item(item: &InstallStatusCompareFontItem, record: &SystemInstalledFontRecord, app_name: &str) -> bool {
    let managed_path = normalize_installed_path(&item.managed_install_path);
    let record_path = normalize_installed_path(first_non_empty(&[&record.path, &record.value]));
    let record_file = clean_font_file_name(first_non_empty(&[&record.file_name, &record.path, &record.value]));
    let managed_file = clean_font_file_name(&safe_managed_font_name(item, app_name));
    (!managed_path.is_empty() && !record_path.is_empty() && managed_path == record_path) || (!managed_file.is_empty() && record_file == managed_file)
}

fn compare_name_candidates_for_font(item: &InstallStatusCompareFontItem) -> Vec<String> {
    unique_candidates([
        item.file_name.clone(),
        file_stem(&item.file_name),
        item.family.clone(),
        item.full_name.clone(),
        item.postscript_name.clone(),
        registry_name_for(item),
    ])
}

fn compare_name_candidates_for_installed_record(record: &SystemInstalledFontRecord) -> Vec<String> {
    let file_name = clean_font_file_name(first_non_empty(&[&record.file_name, &record.path, &record.value]));
    let mut values = vec![file_name.clone(), file_stem(&file_name), record.registry_name.clone(), record.value.clone()];
    values.extend(record.name_candidates.iter().cloned());
    unique_candidates(values)
}

fn unique_candidates<I: IntoIterator<Item = String>>(values: I) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for value in values {
        let normalized = normalize_compare_text(&value);
        if is_usable_installed_name_candidate(&normalized) && seen.insert(normalized.clone()) {
            result.push(normalized);
        }
    }
    result
}

fn is_path_in_windows_fonts(value: &str) -> bool {
    normalize_installed_path(value).contains("\\windows\\fonts\\")
}

fn is_system_installed_record(record: &SystemInstalledFontRecord) -> bool {
    record.source == "HKLM" || record.source == "WindowsFontsFolder" || is_path_in_windows_fonts(first_non_empty(&[&record.path, &record.value]))
}

fn clean_font_file_name(value: &str) -> String {
    file_name_from_path(value).to_lowercase()
}

fn file_name_from_path(value: &str) -> String {
    let trimmed = value.trim_matches('"').replace('/', "\\");
    Path::new(&trimmed)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(trimmed.as_str())
        .to_string()
}

fn file_stem(value: &str) -> String {
    let file_name = file_name_from_path(value);
    Path::new(&file_name)
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(file_name.as_str())
        .to_string()
}

fn extension_lower(value: &str) -> String {
    let file_name = file_name_from_path(value);
    Path::new(&file_name)
        .extension()
        .and_then(|name| name.to_str())
        .map(|ext| format!(".{}", ext.to_lowercase()))
        .unwrap_or_else(String::new)
}

fn clean_file_stem(value: &str, limit: usize) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric() || *ch == ' ' || *ch == '-' || *ch == '_' || is_cjk(*ch))
        .take(limit)
        .collect::<String>()
        .trim()
        .to_string()
}
