use super::*;
use serde_json::json;
#[test]
fn preview_cache_atomicity_commit_failure_rolls_back_both_commands(){for delete in [false,true]{
let path=std::env::temp_dir().join(format!("hfm-preview-commit-{}-{delete}-{}.sqlite",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));let mut conn=Connection::open(&path).unwrap();initialize_preview_cache_db(&conn,1).unwrap();
let payload:PreviewCacheApplyPayload=serde_json::from_value(json!({"dbPath":path.to_str().unwrap(),"rows":[{"preview_key":"a","output_path":"a.png","updated_at":"before"}]})).unwrap();apply_on_connection(&mut conn,&payload,&mut crate::operation_trace::OperationTrace::from_input("{}"),Instant::now()).unwrap();
conn.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE parent(id INTEGER PRIMARY KEY); CREATE TABLE fault(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);").unwrap();
conn.execute_batch(if delete{"CREATE TRIGGER fail AFTER DELETE ON preview_cache BEGIN INSERT INTO fault VALUES(1); END;"}else{"CREATE TRIGGER fail AFTER INSERT ON meta WHEN NEW.key='updatedAt' BEGIN INSERT INTO fault VALUES(1); END;"}).unwrap();
let mut trace=crate::operation_trace::OperationTrace::from_input(&json!({"trace":{"version":1,"sessionId":"test","operationId":"intent","attemptId":"attempt","batchId":"batch","domain":"previewCache"}}).to_string());
let result=if delete{delete_on_connection(&mut conn,&serde_json::from_value(json!({"dbPath":path.to_str().unwrap(),"keys":["a"]})).unwrap(),&mut trace,Instant::now())}else{apply_on_connection(&mut conn,&serde_json::from_value(json!({"dbPath":path.to_str().unwrap(),"rows":[{"preview_key":"a","output_path":"new.png","updated_at":"next"}]})).unwrap(),&mut trace,Instant::now())};
assert!(result.unwrap_err().contains("FOREIGN KEY constraint failed"));assert!(conn.is_autocommit());assert!(trace.context.as_ref().unwrap().get("commitSequence").is_none());let reader=Connection::open(&path).unwrap();assert_eq!(reader.query_row("SELECT output_path FROM preview_cache WHERE preview_key='a'",[],|r|r.get::<_,String>(0)).unwrap(),"a.png");assert_eq!(reader.query_row("SELECT value FROM meta WHERE key='updatedAt'",[],|r|r.get::<_,String>(0)).unwrap(),"before");assert_eq!(reader.query_row("SELECT COUNT(*) FROM fault",[],|r|r.get::<_,i64>(0)).unwrap(),0);drop(reader);drop(conn);let _=fs::remove_file(path);
}}
