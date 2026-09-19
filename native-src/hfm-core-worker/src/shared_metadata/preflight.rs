use std::collections::{BTreeMap, BTreeSet};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use serde_json::{json, Value};
use sha1::{Digest, Sha1};
use super::schema::{initialize_shared_metadata_db, set_meta};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    phase: String,
    updated_at: String,
    updated_by: String,
    writer_pid: i64,
    legacy: Option<Vec<Legacy>>,
    token: Option<String>,
    plan: Option<Plan>,
    maintenance: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Legacy { font_id: String, relative_path: String, path_key: String, tag_names: Vec<String>, favorite: bool, delete_protected: bool }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan { changes: Vec<Change>, meta: BTreeMap<String, String>, updated_at: String, reason: String }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Change { font_id: String, relative_path: String, path_key: String, tag_names: Vec<String>, favorite: i64, delete_protected: i64, revision: i64, insert: bool }

fn tags(value: &str) -> Vec<String> {
    serde_json::from_str::<Vec<Value>>(value).unwrap_or_default().into_iter()
        .filter_map(|tag| match tag { Value::String(value) => Some(value), Value::Number(value) => Some(value.to_string()), Value::Bool(value) => Some(value.to_string()), _ => None })
        .map(|tag| tag.trim().to_string()).filter(|tag| !tag.is_empty()).collect::<BTreeSet<_>>().into_iter().collect()
}
fn meta(conn: &Connection, key: &str) -> rusqlite::Result<String> {
    Ok(conn.query_row("SELECT value FROM meta WHERE key=?", [key], |row| row.get(0)).optional()?.unwrap_or_default())
}
fn read_rows(conn: &Connection, sql: &str) -> rusqlite::Result<Vec<Value>> {
    let mut statement = conn.prepare(sql)?;
    let columns: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();
    let mut query = statement.query([])?;
    let mut records = Vec::new();
    while let Some(row) = query.next()? {
        let mut object = serde_json::Map::new();
        for (index, name) in columns.iter().enumerate() {
            use rusqlite::types::ValueRef;
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(value) => json!(value),
                ValueRef::Real(value) => json!(value),
                ValueRef::Text(value) => json!(String::from_utf8_lossy(value)),
                ValueRef::Blob(_) => return Err(rusqlite::Error::InvalidQuery),
            };
            object.insert(name.clone(), value);
        }
        records.push(Value::Object(object));
    }
    Ok(records)
}
fn snapshot(conn: &Connection) -> rusqlite::Result<Value> {
    let rows = read_rows(conn, "SELECT font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision, updated_at, updated_by FROM font_metadata ORDER BY font_id")?;
    let ops = read_rows(conn, "SELECT rowid, op_id, font_id, relative_path, path_key, action, tag_name, base_revision, next_revision, created_at, machine_id, writer_pid, tombstone FROM shared_tag_ops ORDER BY font_id, tag_name, next_revision, created_at, machine_id, op_id, rowid")?;
    let mut values = BTreeMap::<String, String>::new();
    for row in read_rows(conn, "SELECT key, value FROM meta ORDER BY key")? {
        values.insert(row["key"].as_str().unwrap_or_default().into(), row["value"].as_str().unwrap_or_default().into());
    }
    let mut result = json!({"rows": rows, "ops": ops, "meta": values});
    let token = format!("{:x}", Sha1::digest(result.to_string().as_bytes()));
    result["token"] = json!(token);
    Ok(result)
}
fn import_and_backfill(conn: &Connection, input: &Request) -> rusqlite::Result<()> {
    if let Some(legacy) = &input.legacy {
        if meta(conn, "legacyRootIndexMetadataImportedAt")?.is_empty() {
            let mut imported = 0;
            for row in legacy {
                if row.font_id.is_empty() || (row.tag_names.is_empty() && !row.favorite && !row.delete_protected) { continue; }
                imported += conn.execute("INSERT OR IGNORE INTO font_metadata (font_id, relative_path, path_key, tag_names_json, favorite, delete_protected, revision, updated_at, updated_by) VALUES (?,?,?,?,?,?,1,?,?)", params![row.font_id,row.relative_path,row.path_key,json!(row.tag_names).to_string(),row.favorite,row.delete_protected,input.updated_at,input.updated_by])?;
            }
            set_meta(conn, "legacyRootIndexMetadataImportedAt", &input.updated_at)?;
            set_meta(conn, "updatedAt", &input.updated_at)?;
            if imported > 0 {
                conn.execute("INSERT INTO metadata_events (event_type,font_id,relative_path,payload_json,created_at,writer_host,writer_pid) VALUES ('legacy_import',NULL,NULL,?,?,?,?)", params![json!({"rows":imported}).to_string(),input.updated_at,input.updated_by,input.writer_pid])?;
            }
        }
    }
    let rows = read_rows(conn, "SELECT font_id, relative_path, path_key, tag_names_json, revision, updated_at, updated_by FROM font_metadata ORDER BY font_id")?;
    let mut written = 0;
    for row in rows {
        let font_id = row["font_id"].as_str().unwrap_or_default().trim();
        if font_id.is_empty() { continue; }
        for tag in tags(row["tag_names_json"].as_str().unwrap_or_default()) {
            let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM shared_tag_ops WHERE trim(font_id)=? AND trim(tag_name)=?)", params![font_id,tag], |row| row.get(0))?;
            if exists { continue; }
            let op_id = format!("legacy-bootstrap:{:x}", Sha1::digest(format!("{}\0{}",font_id,tag).as_bytes()));
            let value = |key: &str| row[key].as_str().unwrap_or_default().trim().to_string();
            let created = value("updated_at"); let machine = value("updated_by");
            written += conn.execute("INSERT OR IGNORE INTO shared_tag_ops (op_id,font_id,relative_path,path_key,action,tag_name,base_revision,next_revision,created_at,machine_id,writer_pid,tombstone) VALUES (?,?,?,?,'addTag',?,0,?,?,?,?,0)", params![op_id,font_id,value("relative_path"),value("path_key"),tag,row["revision"].as_i64().unwrap_or(0).max(1),if created.is_empty(){&input.updated_at}else{&created},if machine.is_empty(){"legacy-metadata-backfill"}else{&machine},input.writer_pid])?;
        }
    }
    if written > 0 {
        set_meta(conn, "sharedTagOpsBackfillAt", &input.updated_at)?;
        set_meta(conn, "sharedTagOpsBackfillCount", &written.to_string())?;
    }
    set_meta(conn, "sharedTagOpsBackfillSchemaVersion", "1")?;
    Ok(())
}

const MAINTENANCE_TABLES: [&str; 5] = ["font_metadata", "shared_tag_ops", "shared_tag_ops_archive", "metadata_events", "meta"];
fn initialize_archive(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("CREATE TABLE IF NOT EXISTS shared_tag_ops_archive (
      archive_id INTEGER PRIMARY KEY AUTOINCREMENT, archived_at TEXT NOT NULL,
      archive_reason TEXT NOT NULL, source_table TEXT NOT NULL DEFAULT 'shared_tag_ops',
      op_id TEXT NOT NULL, font_id TEXT, relative_path TEXT, path_key TEXT, action TEXT,
      tag_name TEXT, base_revision INTEGER, next_revision INTEGER, created_at TEXT,
      machine_id TEXT, writer_pid INTEGER, tombstone INTEGER, payload_json TEXT NOT NULL,
      UNIQUE(source_table, op_id, archive_reason));
      CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_archive_op ON shared_tag_ops_archive(op_id);
      CREATE INDEX IF NOT EXISTS idx_shared_tag_ops_archive_reason ON shared_tag_ops_archive(archive_reason, archived_at);")
}
fn maintenance_snapshot(conn: &Connection) -> rusqlite::Result<Value> {
    let mut tables = serde_json::Map::new();
    for table in MAINTENANCE_TABLES {
        tables.insert(table.into(), json!(read_rows(conn, &format!("SELECT rowid AS __rowid, * FROM {} ORDER BY rowid", table))?));
    }
    let token = format!("{:x}", Sha1::digest(Value::Object(tables.clone()).to_string().as_bytes()));
    Ok(json!({"exists":true,"token":token,"tables":tables}))
}
fn commit_maintenance(conn: &Connection, value: &Value) -> Result<(), String> {
    let tables = value.get("tables").and_then(Value::as_object).ok_or("missing maintenance tables")?;
    if tables.len() != MAINTENANCE_TABLES.len() || tables.keys().any(|key| !MAINTENANCE_TABLES.contains(&key.as_str())) { return Err("unexpected maintenance table".into()); }
    // Table identifiers originate only from this fixed list. Column identifiers
    // must match the current schema; callers cannot submit SQL expressions.
    for table in MAINTENANCE_TABLES {
        let columns = read_rows(conn, &format!("PRAGMA table_info({})", table)).map_err(|e|e.to_string())?;
        let expected: BTreeSet<String> = columns.iter().filter_map(|v|v["name"].as_str().map(str::to_string)).chain(std::iter::once("__rowid".into())).collect();
        let rows = tables[table].as_array().ok_or("invalid maintenance rows")?;
        conn.execute(&format!("DELETE FROM {}", table), []).map_err(|e|e.to_string())?;
        for row in rows {
            let row = row.as_object().ok_or("invalid maintenance row")?;
            if row.keys().cloned().collect::<BTreeSet<_>>() != expected { return Err("maintenance schema changed".into()); }
            let names: Vec<String> = row.keys().map(|key| format!("\"{}\"", if key == "__rowid" { "rowid".into() } else { key.replace('"', "\"\"") })).collect();
            let values: Result<Vec<rusqlite::types::Value>, String> = row.values().map(|value| match value {
                Value::Null => Ok(rusqlite::types::Value::Null),
                Value::String(value) => Ok(rusqlite::types::Value::Text(value.clone())),
                Value::Number(value) if value.is_i64() => Ok(rusqlite::types::Value::Integer(value.as_i64().unwrap())),
                Value::Number(value) => value.as_f64().map(rusqlite::types::Value::Real).ok_or("invalid numeric value".into()),
                _ => Err("non-scalar maintenance value".into()),
            }).collect();
            let values = values?;
            conn.execute(&format!("INSERT INTO {} ({}) VALUES ({})", table, names.join(","), vec!["?";values.len()].join(",")), rusqlite::params_from_iter(values)).map_err(|e|e.to_string())?;
        }
    }
    Ok(())
}

pub fn run(conn: &mut Connection, value: &Value) -> Result<Value, String> {
    let input: Request = serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    if !matches!(input.phase.as_str(), "snapshot" | "commit" | "maintenance-snapshot" | "maintenance-commit") || input.updated_at.is_empty() { return Err("invalid shared metadata preflight".into()); }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate).map_err(|error| error.to_string())?;
    initialize_shared_metadata_db(&tx).map_err(|error| error.to_string())?;
    let result = if input.phase.starts_with("maintenance-") {
        initialize_archive(&tx).map_err(|e|e.to_string())?;
        let snapshot = maintenance_snapshot(&tx).map_err(|e|e.to_string())?;
        if input.phase == "maintenance-snapshot" {
            json!({"version":1,"phase":input.phase,"maintenance":snapshot})
        } else {
            if input.token.as_deref() != snapshot["token"].as_str() { return Err("共享元数据已变化，旧维护快照已拒绝。".into()); }
            commit_maintenance(&tx, input.maintenance.as_ref().ok_or("missing maintenance plan")?)?;
            json!({"version":1,"phase":input.phase})
        }
    } else if input.phase == "snapshot" {
        import_and_backfill(&tx, &input).map_err(|error| error.to_string())?;
        json!({"version":1,"phase":"snapshot","snapshot":snapshot(&tx).map_err(|error| error.to_string())?})
    } else {
        let current = snapshot(&tx).map_err(|error| error.to_string())?;
        if input.token.as_deref() != current["token"].as_str() { return Err("共享元数据已变化，旧回放计划已拒绝；请重新读取。".into()); }
        let plan = input.plan.ok_or("missing replay plan")?;
        let mut seen = BTreeSet::new();
        for change in &plan.changes {
            if change.font_id.is_empty() || !seen.insert(&change.font_id) || change.revision < 1 { return Err("invalid replay change".into()); }
            let changed = if change.insert {
                tx.execute("INSERT INTO font_metadata (font_id,relative_path,path_key,tag_names_json,favorite,delete_protected,revision,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?)", params![change.font_id,change.relative_path,change.path_key,json!(change.tag_names).to_string(),change.favorite,change.delete_protected,change.revision,plan.updated_at,format!("tag-ops-replay:{}",plan.reason)])
            } else {
                tx.execute("UPDATE font_metadata SET tag_names_json=?,revision=revision+1,updated_at=?,updated_by=? WHERE font_id=? AND revision=?", params![json!(change.tag_names).to_string(),plan.updated_at,format!("tag-ops-replay:{}",plan.reason),change.font_id,change.revision-1])
            }.map_err(|error| error.to_string())?;
            if changed != 1 { return Err("replay target changed".into()); }
        }
        for (key, value) in &plan.meta {
            if !["sharedTagOpsReplayMaxRowId","sharedTagOpsReplayAt","sharedTagOpsConflictCount","sharedTagOpsConflictSamples","sharedTagOpsConflictPolicy"].contains(&key.as_str()) { return Err("invalid replay meta".into()); }
            set_meta(&tx,key,value).map_err(|error| error.to_string())?;
        }
        json!({"version":1,"phase":"commit"})
    };
    tx.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Value { json!({"phase":"snapshot","updatedAt":"2026-09-18T00:00:00Z","updatedBy":"host","writerPid":1,"legacy":[{"fontId":"font","relativePath":"a.ttf","pathKey":"a","tagNames":["中文"],"favorite":true,"deleteProtected":false}]}) }
    #[test]
    fn import_is_idempotent_and_existing_tombstone_is_not_resurrected() {
        let mut conn = Connection::open_in_memory().unwrap();
        let first = run(&mut conn, &request()).unwrap();
        assert_eq!(first["snapshot"]["rows"].as_array().unwrap().len(),1);
        assert_eq!(first["snapshot"]["ops"].as_array().unwrap().len(),1);
        conn.execute("UPDATE shared_tag_ops SET action='removeTag',tombstone=1",[]).unwrap();
        let second = run(&mut conn, &request()).unwrap();
        assert_eq!(second["snapshot"]["ops"].as_array().unwrap().len(),1);
        assert_eq!(second["snapshot"]["ops"][0]["action"],"removeTag");
        let events: i64 = conn.query_row("SELECT COUNT(*) FROM metadata_events",[],|row|row.get(0)).unwrap();
        assert_eq!(events,1);
    }
    #[test]
    fn maintenance_commit_preserves_rows_and_rejects_stale_or_partial_plan() {
        let mut conn = Connection::open_in_memory().unwrap();
        run(&mut conn, &request()).unwrap();
        let request = json!({"phase":"maintenance-snapshot","updatedAt":"now","updatedBy":"host","writerPid":1});
        let first = run(&mut conn, &request).unwrap();
        let mut commit = json!({"phase":"maintenance-commit","updatedAt":"now","updatedBy":"host","writerPid":1,"token":first["maintenance"]["token"],"maintenance":first["maintenance"]});
        commit["maintenance"]["tables"]["font_metadata"][0]["favorite"] = json!(0);
        assert!(run(&mut conn,&commit).is_ok());
        assert_eq!(conn.query_row("SELECT favorite FROM font_metadata",[],|row|row.get::<_,i64>(0)).unwrap(),0);
        assert!(run(&mut conn,&commit).is_err(), "stale plan was reapplied");
        let fresh = run(&mut conn,&request).unwrap();
        commit["token"] = fresh["maintenance"]["token"].clone();
        commit["maintenance"] = fresh["maintenance"].clone();
        commit["maintenance"]["tables"]["font_metadata"][0]["favorite"] = json!(1);
        commit["maintenance"]["tables"]["metadata_events"][0]["unexpected"] = json!("invalid");
        assert!(run(&mut conn,&commit).is_err());
        assert_eq!(conn.query_row("SELECT favorite FROM font_metadata",[],|row|row.get::<_,i64>(0)).unwrap(),0,"partial failed plan committed");
    }
    #[test]
    fn stale_snapshot_rejects_and_failed_plan_rolls_back_all_changes() {
        let mut conn = Connection::open_in_memory().unwrap();
        let first = run(&mut conn,&request()).unwrap();
        let mut commit = json!({"phase":"commit","updatedAt":"now","updatedBy":"host","writerPid":1,"token":first["snapshot"]["token"],"plan":{"changes":[],"meta":{},"updatedAt":"now","reason":"test"}});
        conn.execute("UPDATE font_metadata SET favorite=0",[]).unwrap();
        assert!(run(&mut conn,&commit).is_err());
        commit["token"] = snapshot(&conn).unwrap()["token"].clone();
        commit["plan"]["changes"] = json!([{"fontId":"font","relativePath":"a.ttf","pathKey":"a","tagNames":[],"favorite":0,"deleteProtected":0,"revision":2,"insert":false}]);
        commit["plan"]["meta"] = json!({"invalid-key":"bad"});
        assert!(run(&mut conn,&commit).is_err());
        let revision: i64 = conn.query_row("SELECT revision FROM font_metadata",[],|row|row.get(0)).unwrap();
        assert_eq!(revision,1);
        commit["plan"]["meta"] = json!({"sharedTagOpsReplayMaxRowId":"1"});
        assert_eq!(run(&mut conn,&commit).unwrap()["phase"],"commit");
    }
}
