use std::{sync::atomic::{AtomicU64, Ordering}, fs,path::PathBuf,process::{Command,Output},time::{SystemTime,UNIX_EPOCH}};
use rusqlite::Connection;
use serde_json::{json,Value};
struct Fixture {dir:PathBuf,db:PathBuf}
impl Fixture {
 fn new()->Self {static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("hfm-preview-{}-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(), NEXT.fetch_add(1, Ordering::Relaxed)));fs::create_dir_all(&dir).unwrap();let f=Self{db:dir.join("preview.sqlite"),dir};assert!(f.run(false,json!({"rows":[row("a","before"),row("b","before")]})).status.success());f}
 fn reader(&self)->Connection{Connection::open(&self.db).unwrap()}
 fn command(&self,delete:bool,extra:Value)->Command{let mut p=json!({"dbPath":self.db.to_str().unwrap(),"schemaVersion":1,"keys":["a","b"],"rows":[row("a","next"),row("b","next")],"trace":{"version":1,"sessionId":"preview-test","operationId":"intent","attemptId":"attempt","batchId":"batch","domain":"previewCache","members":["intent"],"omitted":0,"spanId":"span"}});for(k,v)in extra.as_object().unwrap(){p[k]=v.clone();}let input=self.dir.join("input.json");fs::write(&input,p.to_string()).unwrap();let mut c=Command::new(env!("CARGO_BIN_EXE_hfm-core-worker"));c.arg(if delete{"--preview-cache-delete"}else{"--preview-cache-apply"}).arg("--input").arg(input);c}
 fn run(&self,delete:bool,p:Value)->Output{self.command(delete,p).output().unwrap()}
 fn snapshot(&self)->Vec<Vec<String>>{let conn=self.reader();["SELECT quote(preview_key)||quote(output_path)||quote(status)||quote(fail_count)||quote(font_id)||quote(generated_at)||quote(updated_at) FROM preview_cache ORDER BY preview_key","SELECT key||quote(value) FROM meta ORDER BY key"].iter().map(|s|conn.prepare(s).unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().map(Result::unwrap).collect()).collect()}
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.dir);}}
fn row(key:&str,time:&str)->Value{json!({"preview_key":key,"output_path":format!("{key}.png"),"status":"ok","updated_at":time,"font_id":"font","generated_at":"generated","fail_count":3})}
fn events(o:&Output)->Vec<Value>{String::from_utf8_lossy(&o.stderr).lines().filter_map(|l|l.strip_prefix("operation-chain: ")).map(|s|serde_json::from_str(s).unwrap()).collect()}
fn success(o:&Output)->Value{assert!(o.status.success(),"{}",String::from_utf8_lossy(&o.stderr));let e=events(o);assert_eq!(e.iter().map(|v|v["stage"].as_str().unwrap()).collect::<Vec<_>>(),["backend-start","commit","backend-result"]);assert_eq!(e[1]["trace"]["commitSequence"],e[1]["backendSequence"]);serde_json::from_slice(&o.stdout).unwrap()}
#[test]
fn preview_cache_atomicity_row_and_meta_failures(){for(delete,label,sql)in [
(false,"row","CREATE TRIGGER fail BEFORE INSERT ON preview_cache WHEN NEW.preview_key='b' BEGIN SELECT RAISE(ABORT,'row'); END;"),
(false,"metadata","CREATE TRIGGER fail BEFORE INSERT ON meta WHEN NEW.key='updatedAt' BEGIN SELECT RAISE(ABORT,'meta'); END;"),
(true,"delete","CREATE TRIGGER fail BEFORE DELETE ON preview_cache WHEN OLD.preview_key='b' BEGIN SELECT RAISE(ABORT,'delete'); END;")]{let f=Fixture::new();let before=f.snapshot();f.reader().execute_batch(sql).unwrap();let o=f.run(delete,json!({}));assert!(!o.status.success());assert_eq!(f.snapshot(),before,"{label} leaked partial writes");assert!(!events(&o).iter().any(|v|v["stage"]=="commit"));assert_eq!(events(&o).last().unwrap()["outcome"],"unknown");}}
#[test]
fn preview_cache_atomicity_empty_invalid_status_and_delete_contracts(){let f=Fixture::new();let before=f.snapshot();assert_eq!(success(&f.run(false,json!({"rows":[]})))["written"],0);assert_eq!(f.snapshot(),before);
let invalid=json!({"preview_key":" ","output_path":"","updated_at":"invalid-first"});let mut changed=row("a","next");changed["status"]=json!("failed");changed["fail_count"]=json!(-1);changed["font_id"]=Value::Null;changed["generated_at"]=Value::Null;
assert_eq!(success(&f.run(false,json!({"rows":[invalid,changed]})))["written"],1);
let reader=f.reader();assert_eq!(reader.query_row("SELECT value FROM meta WHERE key='updatedAt'",[],|r|r.get::<_,String>(0)).unwrap(),"invalid-first");
assert_eq!(reader.query_row("SELECT status,fail_count,font_id,generated_at FROM preview_cache WHERE preview_key='a'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?))).unwrap(),("failed".into(),3,"font".into(),"generated".into()));
for status in ["missing","unknown"]{let mut r=row("a","next");r["status"]=json!(status);success(&f.run(false,json!({"rows":[r]})));assert_eq!(reader.query_row("SELECT status FROM preview_cache WHERE preview_key='a'",[],|r|r.get::<_,String>(0)).unwrap(),if status=="unknown"{"pending"}else{status});}
assert_eq!(success(&f.run(true,json!({"keys":[" ","a","a"]})))["deleted"],1);assert_eq!(success(&f.run(true,json!({"keys":[]})))["deleted"],0);success(&f.run(false,json!({"rows":[row("a","again")]})));assert_eq!(reader.query_row("SELECT COUNT(*) FROM preview_cache",[],|r|r.get::<_,i64>(0)).unwrap(),2);}
#[cfg(unix)]
#[test]
fn preview_cache_atomicity_log_io_failure_keeps_commit(){for delete in [false,true]{let f=Fixture::new();let o=f.command(delete,json!({})).stderr(fs::OpenOptions::new().write(true).open("/dev/full").unwrap()).output().unwrap();assert!(o.status.success());assert_eq!(f.reader().query_row("SELECT COUNT(*) FROM preview_cache",[],|r|r.get::<_,i64>(0)).unwrap(),if delete{0}else{2});}}
