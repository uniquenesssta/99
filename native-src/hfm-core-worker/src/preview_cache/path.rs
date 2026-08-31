pub fn normalize_path_for_cache_compare(value: &str) -> String {
    let replaced = value.replace('/', "\\");
    replaced.trim_end_matches('\\').to_ascii_lowercase()
}
