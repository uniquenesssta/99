use std::collections::BTreeSet;

use rusqlite::{Connection, OptionalExtension};

use super::schema::set_app_state;

pub fn clean_tag_names(values: &[String]) -> Vec<String> {
    let mut tags = BTreeSet::new();
    for value in values {
        let tag = value.trim();
        if !tag.is_empty() {
            tags.insert(tag.to_string());
        }
    }
    tags.into_iter().collect()
}

pub fn read_catalog_tags(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let value = conn
        .query_row(
            "SELECT value FROM app_state WHERE key = 'localTags'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    let parsed = value
        .as_deref()
        .and_then(|json| serde_json::from_str::<Vec<String>>(json).ok())
        .unwrap_or_default();
    Ok(clean_tag_names(&parsed))
}

pub fn read_bound_tags(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT tag_name FROM local_font_tags
         WHERE TRIM(COALESCE(tag_name, '')) <> '' ORDER BY tag_name",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut tags = Vec::new();
    for row in rows {
        tags.push(row?);
    }
    Ok(clean_tag_names(&tags))
}

pub fn merge_tag_sets<'a>(sources: impl IntoIterator<Item = &'a [String]>) -> Vec<String> {
    let mut tags = BTreeSet::new();
    for source in sources {
        for tag in clean_tag_names(source) {
            tags.insert(tag);
        }
    }
    tags.into_iter().collect()
}

pub fn read_known_tags(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let catalog = read_catalog_tags(conn)?;
    let bound = read_bound_tags(conn)?;
    Ok(merge_tag_sets([catalog.as_slice(), bound.as_slice()]))
}

pub fn save_known_tags(conn: &Connection, tags: &[String]) -> rusqlite::Result<()> {
    let json = serde_json::to_string(&clean_tag_names(tags)).unwrap_or_else(|_| "[]".to_string());
    set_app_state(conn, "localTags", &json)
}

pub fn known_tag_diff(previous: &[String], next: &[String]) -> (Vec<String>, Vec<String>) {
    let previous_set: BTreeSet<String> = clean_tag_names(previous).into_iter().collect();
    let next_set: BTreeSet<String> = clean_tag_names(next).into_iter().collect();
    let added = next_set.difference(&previous_set).cloned().collect();
    let removed = previous_set.difference(&next_set).cloned().collect();
    (added, removed)
}

pub fn retained_empty_tags(
    previous_bound: &[String],
    next_bound: &[String],
    known_tags: &[String],
) -> Vec<String> {
    let previous_set: BTreeSet<String> = clean_tag_names(previous_bound).into_iter().collect();
    let next_set: BTreeSet<String> = clean_tag_names(next_bound).into_iter().collect();
    let known_set: BTreeSet<String> = clean_tag_names(known_tags).into_iter().collect();
    previous_set
        .difference(&next_set)
        .filter(|tag| known_set.contains(*tag))
        .cloned()
        .collect()
}

pub fn remove_known_tag(known_tags: &[String], tag_name: &str) -> Vec<String> {
    let target = tag_name.trim();
    clean_tag_names(known_tags)
        .into_iter()
        .filter(|tag| tag != target)
        .collect()
}
