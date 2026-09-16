//! Real Rust commands and isolated SQLite databases, including R-01 commit receipts.
use std::{fs, path::PathBuf, process::{Command, Output}, time::{SystemTime, UNIX_EPOCH}};
use rusqlite::Connection;
use serde_json::{json, Value};
struct Fixture { dir: PathBuf, db: PathBuf }
impl Fixture {
    fn new() -> Self {
        let dir=std::env::temp_dir().join(format!("hfm-shared-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&dir).unwrap(); let f=Self {db:dir.join("shared.sqlite"),dir};
        assert!(f.run(false,json!({"updatedAt":"before","rows":[row("a","old"),row("b","old")]})).status.success());
        f.reader().execute_batch("CREATE TABLE local_sentinel(value TEXT); INSERT INTO local_sentinel VALUES('local-tag-unchanged');").unwrap();
        f
    }
    fn reader(&self)->Connection {Connection::open(&self.db).unwrap()}
    fn command(&self,delete:bool,extra:Value)->Command {
        let mut payload=json!({"dbPath":self.db.to_str().unwrap(),"rootPath":"root","updatedAt":"next","updatedBy":"host","writerPid":123,"tagName":"old","rows":[row("a","new"),row("b","new")],"trace":{"version":1,"sessionId":"shared-test","operationId":"intent","attemptId":"attempt","batchId":"batch","domain":"sharedMetadata","members":["intent"],"omitted":0,"spanId":"span"}});
        for(k,v)in extra.as_object().unwrap(){payload[k]=v.clone();}
        let input=self.dir.join("input.json"); fs::write(&input,serde_json::to_vec(&payload).unwrap()).unwrap();
        let mut c=Command::new(env!("CARGO_BIN_EXE_hfm-core-worker"));
        c.arg(if delete{"--shared-metadata-remove-tag"}else{"--shared-metadata-apply"}).arg("--input").arg(input); c
    }
    fn run(&self,delete:bool,extra:Value)->Output {self.command(delete,extra).output().unwrap()}
    fn snapshot(&self)->Vec<Vec<String>> {
        let conn=self.reader();
        ["SELECT quote(font_id)||quote(tag_names_json)||quote(favorite)||quote(delete_protected)||quote(revision)||quote(updated_at)||quote(updated_by) FROM font_metadata ORDER BY font_id",
         "SELECT quote(op_id)||quote(font_id)||quote(action)||quote(tag_name)||quote(base_revision)||quote(next_revision)||quote(tombstone) FROM shared_tag_ops ORDER BY op_id",
         "SELECT quote(event_id)||quote(font_id)||quote(payload_json)||quote(created_at) FROM metadata_events ORDER BY event_id",
         "SELECT key||quote(value) FROM meta ORDER BY key", "SELECT value FROM local_sentinel"].iter().map(|sql|conn.prepare(sql).unwrap().query_map([],|r|r.get::<_,String>(0)).unwrap().map(Result::unwrap).collect()).collect()
    }
}
impl Drop for Fixture {fn drop(&mut self){let _=fs::remove_dir_all(&self.dir);}}
fn row(id:&str,tag:&str)->Value {json!({"fontId":id,"relativePath":format!("{}.ttf",id),"pathKey":id,"tagNamesJson":json!([tag]).to_string(),"baseTagNamesJson":"[]","favorite":true,"deleteProtected":true,"mergePolicy":"replace"})}
fn events(o:&Output)->Vec<Value>{String::from_utf8_lossy(&o.stderr).lines().filter_map(|s|s.strip_prefix("operation-chain: ")).map(|s|serde_json::from_str(s).unwrap()).collect()}
fn success(o:&Output,committed:bool)->Value {
    assert!(o.status.success(),"{}",String::from_utf8_lossy(&o.stderr));let r:Value=serde_json::from_slice(&o.stdout).unwrap();let e=events(o);
    assert_eq!(e.iter().filter(|v|v["stage"]=="commit").count(),if committed{1}else{0});
    assert_eq!(e.last().unwrap()["outcome"],"returned");
    if committed{assert_eq!(r["stateSignal"]["trace"]["commitSequence"],e.iter().find(|v|v["stage"]=="commit").unwrap()["backendSequence"]);}
    r
}
#[test]
fn shared_metadata_atomicity_faults_restore_rows_ops_events_and_meta() {
    for delete in [false,true] {
        for (label,trigger) in [
            ("row",if delete{"CREATE TRIGGER fail BEFORE UPDATE ON font_metadata WHEN NEW.font_id='b' BEGIN SELECT RAISE(ABORT,'row'); END;"}else{"CREATE TRIGGER fail BEFORE INSERT ON font_metadata WHEN NEW.font_id='b' BEGIN SELECT RAISE(ABORT,'row'); END;"}),
            ("ops","CREATE TRIGGER fail BEFORE INSERT ON shared_tag_ops WHEN NEW.font_id='b' BEGIN SELECT RAISE(ABORT,'ops'); END;"),
            ("events","CREATE TRIGGER fail BEFORE INSERT ON metadata_events WHEN NEW.font_id='b' BEGIN SELECT RAISE(ABORT,'event'); END;"),
            ("updatedAt","CREATE TRIGGER fail BEFORE INSERT ON meta WHEN NEW.key='updatedAt' BEGIN SELECT RAISE(ABORT,'meta'); END;"),
            ("writerHost","CREATE TRIGGER fail BEFORE INSERT ON meta WHEN NEW.key='writerHost' BEGIN SELECT RAISE(ABORT,'meta'); END;"),
            ("rootPath","CREATE TRIGGER fail BEFORE INSERT ON meta WHEN NEW.key='rootPath' BEGIN SELECT RAISE(ABORT,'meta'); END;"),
            ("signature","CREATE TRIGGER fail AFTER INSERT ON meta WHEN NEW.key='writerHost' BEGIN UPDATE font_metadata SET revision='bad'; END;"),
            ("signature-meta","CREATE TRIGGER fail AFTER INSERT ON meta WHEN NEW.key='writerHost' BEGIN UPDATE meta SET value=X'80' WHERE key='updatedAt'; END;")
        ] {
            let f=Fixture::new();let before=f.snapshot(); f.reader().execute_batch(trigger).unwrap();
            let output=f.run(delete,json!({}));assert!(!output.status.success(),"{label}/{delete} unexpectedly succeeded");
            assert_eq!(f.snapshot(),before,"{label} leaked partial writes (delete={delete})");
            let e=events(&output);assert!(!e.iter().any(|v|v["stage"]=="commit"));assert_eq!(e.last().unwrap()["outcome"],"unknown");
        }
    }
}
#[test]
fn shared_metadata_atomicity_merge_and_field_isolation() {
    let f=Fixture::new();
    let mut edit=row("a","new");edit["mergePolicy"]=json!("tags");edit["baseTagNamesJson"]=json!("[]");edit["favorite"]=json!(false);edit["deleteProtected"]=json!(false);
    let r=success(&f.run(false,json!({"rows":[edit]})),true);assert_eq!(r["changedIds"],json!(["a"]));
    let reader=f.reader();
    let state=||reader.query_row("SELECT tag_names_json,favorite,delete_protected,revision FROM font_metadata WHERE font_id='a'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?))).unwrap();
    assert_eq!(state(),("[\"new\",\"old\"]".to_string(),1,1,2));
    for (policy,favorite,protected) in [("favorite",0,1),("deleteProtected",0,0)] {
        let mut edit=row("a","stale"); edit["mergePolicy"]=json!(policy);edit["favorite"]=json!(false);edit["deleteProtected"]=json!(false);
        success(&f.run(false,json!({"rows":[edit]})),true);
        let s=state();assert_eq!((s.0,s.1,s.2),("[\"new\",\"old\"]".to_string(),favorite,protected));
    }
    let deleted=success(&f.run(true,json!({})),true);assert_eq!(deleted["updatedIds"],json!(["a","b"]));assert_eq!(state(),("[\"new\"]".to_string(),0,0,5));
    // Verify the returned signature against the real read command, not a reconstructed formula.
    let input=f.dir.join("signature.json");fs::write(&input,json!({"dbPath":f.db.to_str().unwrap()}).to_string()).unwrap();
    let output=Command::new(env!("CARGO_BIN_EXE_hfm-core-worker")).args(["--shared-metadata-signature","--input"]).arg(input).output().unwrap();
    assert!(output.status.success());assert_eq!(deleted["signature"],serde_json::from_slice::<Value>(&output.stdout).unwrap()["signature"]);
    assert_eq!(reader.query_row("SELECT value FROM local_sentinel",[],|r|r.get::<_,String>(0)).unwrap(),"local-tag-unchanged");
}
#[test]
fn shared_metadata_atomicity_empty_and_no_change_contracts() {
    let f=Fixture::new();let before=f.snapshot();
    let r=success(&f.run(false,json!({"updatedAt":"before","rows":[row("a","old")]})),true);assert_eq!(r["written"],0);assert_eq!(f.snapshot(),before);
    let empty=success(&f.run(false,json!({"updatedAt":"before","rows":[]})),true);assert_eq!(empty["changedIds"],json!([]));assert_eq!(f.snapshot(),before);
    for tag in [" ","missing"] {let r=success(&f.run(true,json!({"tagName":tag})),false);assert_eq!(r["updated"],0);assert_eq!(f.snapshot(),before);}
}
#[cfg(unix)]
#[test]
fn shared_metadata_atomicity_logging_failure_keeps_committed_result() {
    for delete in [false,true] {let f=Fixture::new();let output=f.command(delete,json!({})).stderr(fs::OpenOptions::new().write(true).open("/dev/full").unwrap()).output().unwrap();assert!(output.status.success());let r:Value=serde_json::from_slice(&output.stdout).unwrap();assert_eq!(r["ok"],true);assert_eq!(f.reader().query_row("SELECT value FROM meta WHERE key='updatedAt'",[],|r|r.get::<_,String>(0)).unwrap(),"next");}
}
