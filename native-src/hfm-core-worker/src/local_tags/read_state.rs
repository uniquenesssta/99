use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::time::Instant;

use rusqlite::{params_from_iter, Connection};
use super::catalog::{read_catalog_tags, read_known_tags};
use super::types::{LocalTagsCommandConfig, LocalTagsReadPayload, LocalTagsReadResult, LocalTagsTimings};

const SQLITE_IN_CHUNK_SIZE: usize = 500;

pub fn read_local_tags_state_machine(config: &LocalTagsCommandConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let input = fs::read_to_string(&config.input_path).map_err(|error| error.to_string())?;
    let payload: LocalTagsReadPayload = serde_json::from_str(&input).map_err(|error| error.to_string())?;
    let result = read_local_tags(&payload, started_at)?;
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn read_local_tags(payload: &LocalTagsReadPayload, started_at: Instant) -> Result<LocalTagsReadResult, String> {
    let db_path = payload.db_path.trim();
    if db_path.is_empty() || !Path::new(db_path).exists() {
        return Ok(LocalTagsReadResult {
            ok: true,
            tag_map: BTreeMap::new(),
            known_tags: Vec::new(),
            signature: "local-tags:none".to_string(),
            timings: LocalTagsTimings { elapsed: started_at.elapsed().as_millis(), rows: 0 },
            worker_mode: "rust-local-tags-read".to_string(),
        });
    }

    let conn = Connection::open(db_path).map_err(|error| error.to_string())?;
    if !table_exists(&conn, "local_font_tags").map_err(|error| error.to_string())? {
        let known_tags = read_catalog_tags(&conn).unwrap_or_default();
        let catalog_json = serde_json::to_string(&known_tags).unwrap_or_else(|_| "[]".to_string());
        return Ok(LocalTagsReadResult {
            ok: true,
            tag_map: BTreeMap::new(),
            known_tags,
            signature: format!("local-tags-v2|catalog-only|{}", catalog_json),
            timings: LocalTagsTimings { elapsed: started_at.elapsed().as_millis(), rows: 0 },
            worker_mode: "rust-local-tags-read".to_string(),
        });
    }

    let mut alias_to_item = HashMap::<String, BTreeSet<String>>::new();
    let mut path_to_item = HashMap::<String, BTreeSet<String>>::new();
    let mut aliases = Vec::<String>::new();
    let mut paths = Vec::<String>::new();

    for row in &payload.rows {
        let item_id = clean_value(&row.item_id);
        if item_id.is_empty() {
            continue;
        }
        for alias in &row.aliases {
            let alias = clean_value(alias);
            if alias.is_empty() {
                continue;
            }
            if !alias_to_item.contains_key(&alias) {
                aliases.push(alias.clone());
            }
            alias_to_item.entry(alias).or_default().insert(item_id.clone());
        }
        let font_path = clean_value(&row.font_path);
        if !font_path.is_empty() {
            if !path_to_item.contains_key(&font_path) {
                paths.push(font_path.clone());
            }
            path_to_item.entry(font_path).or_default().insert(item_id);
        }
    }

    let mut tag_map = BTreeMap::<String, BTreeSet<String>>::new();
    read_tags_by_column(&conn, "font_id", &aliases, &alias_to_item, &mut tag_map).map_err(|error| error.to_string())?;
    read_tags_by_column(&conn, "font_path", &paths, &path_to_item, &mut tag_map).map_err(|error| error.to_string())?;

    let known_tags = read_known_tags(&conn).map_err(|error| error.to_string())?;
    let signature = local_tags_signature_for_conn(&conn).map_err(|error| error.to_string())?;
    let mut normalized_map = BTreeMap::<String, Vec<String>>::new();
    let mut rows = 0usize;
    for (item_id, tags) in tag_map {
        let tag_list: Vec<String> = tags.into_iter().collect();
        rows += tag_list.len();
        normalized_map.insert(item_id, tag_list);
    }

    Ok(LocalTagsReadResult {
        ok: true,
        tag_map: normalized_map,
        known_tags,
        signature,
        timings: LocalTagsTimings { elapsed: started_at.elapsed().as_millis(), rows },
        worker_mode: "rust-local-tags-read".to_string(),
    })
}

fn read_tags_by_column(
    conn: &Connection,
    column: &str,
    values: &[String],
    value_to_item: &HashMap<String, BTreeSet<String>>,
    tag_map: &mut BTreeMap<String, BTreeSet<String>>,
) -> rusqlite::Result<()> {
    if values.is_empty() {
        return Ok(());
    }
    for chunk in values.chunks(SQLITE_IN_CHUNK_SIZE) {
        let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT {column} AS lookup_value, tag_name FROM local_font_tags WHERE {column} IN ({placeholders}) ORDER BY tag_name"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(chunk.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (lookup_value, tag_name) = row?;
            let tag_name = clean_value(&tag_name);
            if !tag_name.is_empty() {
                if let Some(item_ids) = value_to_item.get(&lookup_value) {
                    for item_id in item_ids {
                        tag_map.entry(item_id.clone()).or_default().insert(tag_name.clone());
                    }
                }
            }
        }
    }
    Ok(())
}

fn local_tags_signature_for_conn(conn: &Connection) -> rusqlite::Result<String> {
    if !table_exists(conn, "local_font_tags")? {
        return Ok("local-tags:none".to_string());
    }
    let updated_at = read_meta(conn, "localTagsUpdatedAt")
        .or_else(|| read_meta(conn, "updatedAt"))
        .unwrap_or_default();
    let row = conn.query_row(
        "SELECT COUNT(*) AS count,
                COALESCE(MAX(updated_at), '') AS max_updated_at,
                COALESCE(COUNT(DISTINCT tag_name), 0) AS tag_count
         FROM local_font_tags",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    let catalog_json = serde_json::to_string(&read_catalog_tags(conn)?)
        .unwrap_or_else(|_| "[]".to_string());
    Ok(format!(
        "local-tags-v2|{}|{}|{}|{}|{}",
        updated_at, row.0, row.1, row.2, catalog_json
    ))
}

fn table_exists(conn: &Connection, table_name: &str) -> rusqlite::Result<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?",
        [table_name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn read_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM meta WHERE key=?", [key], |row| row.get(0)).ok()
}

fn clean_value(value: &str) -> String {
    value.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::types::LocalTagsReadRow;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TestDb(std::path::PathBuf);
    impl Drop for TestDb {
        fn drop(&mut self) { let _ = fs::remove_file(&self.0); }
    }
    fn fixture() -> (TestDb, Connection) {
        let name = format!("hfm-local-tags-{}-{}.db", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos());
        let file = TestDb(std::env::temp_dir().join(name));
        let conn = Connection::open(&file.0).unwrap();
        conn.execute_batch("CREATE TABLE local_font_tags(font_id TEXT, font_path TEXT, tag_name TEXT, updated_at TEXT);
            CREATE TABLE app_state(key TEXT PRIMARY KEY, value TEXT);").unwrap();
        (file, conn)
    }
    fn row(id: &str, aliases: &[&str], path: &str) -> LocalTagsReadRow {
        LocalTagsReadRow { item_id: id.into(), aliases: aliases.iter().map(|x| x.to_string()).collect(), font_path: path.into() }
    }
    #[test]
    fn hydration_shared_alias_and_path_preserve_all_items() {
        let (file, conn) = fixture();
        conn.execute_batch(r"INSERT INTO local_font_tags VALUES
            ('shared','','common',''), ('a','','only-a',''),
            ('','c:\one.ttf','path',''), ('','c:\one.ttf','path',''),
            ('independent','','isolated','');").unwrap();
        drop(conn);
        let rows = vec![row("a", &["a", "shared"], r"c:\one.ttf"), row("b", &["b", "shared"], r"c:\two.ttf"),
            row("c", &["c"], r"c:\one.ttf"), row("independent", &["independent"], ""),
            row("no-path", &["no-path", "shared"], ""), row("a", &["a", "shared"], r"c:\one.ttf")];
        let payload = LocalTagsReadPayload { db_path: file.0.to_string_lossy().into_owned(), rows };
        let result = read_local_tags(&payload, Instant::now()).unwrap();
        for (id, expected) in [("a", vec!["common", "only-a", "path"]), ("b", vec!["common"]),
            ("c", vec!["path"]), ("independent", vec!["isolated"]), ("no-path", vec!["common"])] {
            assert_eq!(result.tag_map.get(id).unwrap(), &expected);
        }
        assert_eq!(result.tag_map.len(), 5);
        assert_eq!(payload.rows.len(), 6);
        let empty = LocalTagsReadPayload { db_path: payload.db_path, rows: vec![] };
        assert!(read_local_tags(&empty, Instant::now()).unwrap().tag_map.is_empty());
    }
    #[test]
    fn hydration_chunks_over_five_hundred_keep_alias_and_path_matches() {
        let (file, conn) = fixture();
        let mut rows = Vec::new();
        for i in 0..1001 {
            let id = format!("id-{i}");
            let path = format!("path-{i}");
            conn.execute("INSERT INTO local_font_tags VALUES (?1, '', 'alias', '')", [&id]).unwrap();
            conn.execute("INSERT INTO local_font_tags VALUES ('', ?1, 'path', '')", [&path]).unwrap();
            rows.push(row(&id, &[&id], &path));
        }
        drop(conn);
        let result = read_local_tags(&LocalTagsReadPayload { db_path: file.0.to_string_lossy().into_owned(), rows }, Instant::now()).unwrap();
        assert_eq!(result.tag_map.len(), 1001);
        for tags in result.tag_map.values() { assert_eq!(tags, &vec!["alias", "path"]); }
    }
}
