use super::*;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{fs, path::PathBuf};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("hfm-preview-readonly-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&path).unwrap(); Self(path)
    }
    fn call(&self, command: fn(&PreviewCacheCommandConfig) -> Result<String,String>, db: &str, read_only: bool) -> Result<Value,String> {
        let input = self.0.join("input.json");
        fs::write(&input, json!({"dbPath":self.0.join(db),"schemaVersion":1,"readOnly":read_only,"previewKey":"key","outputPath":"image.png","now":"new-time","touchMatched":true,"checkFiles":false,"acceptedStatuses":["ok"],"rows":[{"id":"font","previewKey":"key","outputPath":"image.png"}]}).to_string()).unwrap();
        command(&PreviewCacheCommandConfig{input_path:input.to_string_lossy().into_owned()}).map(|result|serde_json::from_str(&result).unwrap())
    }
    fn seed(&self) {
        let conn = Connection::open(self.0.join("cache.sqlite")).unwrap();
        initialize_preview_cache_db(&conn,1).unwrap();
        conn.execute("INSERT INTO preview_cache(preview_key,relative_path,output_path,font_signature,text_hash,font_size,width,height,storage,status,accessed_at,updated_at) VALUES ('key','','image.png','','',12,1,1,'root','ok',?,?)",params!["old-time","old-time"]).unwrap();
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

#[test]
fn readonly_commands_preserve_database_bytes_schema_meta_rows_and_directory() {
    let fixture = Fixture::new(); fixture.seed();
    let before = fs::read(fixture.0.join("cache.sqlite")).unwrap();
    for command in [read_preview_cache_status,query_preview_cache_status,query_preview_cache_batch] {
        let result=fixture.call(command,"cache.sqlite",true).unwrap();
        assert_eq!(result["ok"],true);
        assert!(result["touched"] == false || result["touched"] == 0);
        assert_eq!(fs::read(fixture.0.join("cache.sqlite")).unwrap(),before);
        let mut names:Vec<_>=fs::read_dir(&fixture.0).unwrap().map(|entry|entry.unwrap().file_name()).collect();names.sort();
        assert_eq!(names,vec![std::ffi::OsString::from("cache.sqlite"),std::ffi::OsString::from("input.json")]);
    }
    assert_eq!(fixture.call(read_preview_cache_status,"cache.sqlite",false).unwrap()["touched"],true);
    let conn=Connection::open(fixture.0.join("cache.sqlite")).unwrap();
    assert_eq!(conn.query_row("SELECT accessed_at FROM preview_cache",[],|row|row.get::<_,String>(0)).unwrap(),"new-time");
}

#[test]
fn readonly_unavailable_is_not_a_miss_and_never_creates_or_repairs() {
    let fixture=Fixture::new();
    for command in [read_preview_cache_status,query_preview_cache_status,query_preview_cache_batch] {
        assert!(fixture.call(command,"absent/cache.sqlite",true).unwrap_err().contains("unavailable"));
        assert!(!fixture.0.join("absent").exists());
    }
    let old=fixture.0.join("old.sqlite");
    Connection::open(&old).unwrap().execute_batch("CREATE TABLE preview_cache (preview_key TEXT)").unwrap();
    let before=fs::read(&old).unwrap();
    assert!(fixture.call(read_preview_cache_status,"old.sqlite",true).unwrap_err().contains("incompatible"));
    assert_eq!(fs::read(&old).unwrap(),before);
    fs::write(fixture.0.join("corrupt.sqlite"),b"not sqlite").unwrap();
    assert!(fixture.call(query_preview_cache_batch,"corrupt.sqlite",true).is_err());
    assert_eq!(fs::read(fixture.0.join("corrupt.sqlite")).unwrap(),b"not sqlite");
    fixture.seed();
    let writer=Connection::open(fixture.0.join("cache.sqlite")).unwrap();writer.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(fixture.call(query_preview_cache_status,"cache.sqlite",true).is_err());
    writer.execute_batch("ROLLBACK").unwrap();
    assert_eq!(fixture.call(query_preview_cache_status,"cache.sqlite",true).unwrap()["matched"],1);
}
