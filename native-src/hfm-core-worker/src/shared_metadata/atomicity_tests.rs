use super::*;
use serde_json::json;

#[test]
fn shared_metadata_atomicity_commit_failure_rolls_back_apply_and_remove() {
    for delete in [false,true] {
        let path=std::env::temp_dir().join(format!("hfm-shared-commit-{}-{}-{}.sqlite",std::process::id(),delete,SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let mut conn=Connection::open(&path).unwrap();initialize_shared_metadata_db(&conn).unwrap();
        conn.execute_batch("INSERT INTO font_metadata(font_id,tag_names_json,favorite,delete_protected,revision,updated_at) VALUES('a','[\"old\"]',1,1,1,'before');
            INSERT INTO meta VALUES('updatedAt','before'); PRAGMA foreign_keys=ON;
            CREATE TABLE parent(id INTEGER PRIMARY KEY);
            CREATE TABLE deferred_fault(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER fail_commit AFTER INSERT ON meta WHEN NEW.key='updatedAt' BEGIN INSERT INTO deferred_fault VALUES(1); END;").unwrap();
        let mut trace=crate::operation_trace::OperationTrace::from_input(&json!({"trace":{"version":1,"sessionId":"commit","operationId":"intent","attemptId":"attempt","batchId":"batch","domain":"sharedMetadata"}}).to_string());
        let result=if delete {
            remove_on_connection(&mut conn,&serde_json::from_value(json!({"dbPath":path.to_str().unwrap(),"tagName":"old","updatedAt":"next"})).unwrap(),&mut trace,Instant::now())
        }else{
            apply_on_connection(&mut conn,&serde_json::from_value(json!({"dbPath":path.to_str().unwrap(),"updatedAt":"next","rows":[{"fontId":"a","tagNamesJson":"[\"new\"]","baseTagNamesJson":"[\"old\"]","mergePolicy":"tags"}]})).unwrap(),&mut trace,Instant::now())
        };
        assert!(result.unwrap_err().contains("FOREIGN KEY constraint failed"));assert!(conn.is_autocommit());assert!(trace.context.as_ref().unwrap().get("commitSequence").is_none());
        let reader=Connection::open(&path).unwrap();
        assert_eq!(reader.query_row("SELECT tag_names_json,favorite,delete_protected,revision FROM font_metadata WHERE font_id='a'",[],|r|Ok((r.get::<_,String>(0)?,r.get::<_,i64>(1)?,r.get::<_,i64>(2)?,r.get::<_,i64>(3)?))).unwrap(),("[\"old\"]".to_string(),1,1,1));
        assert_eq!(reader.query_row("SELECT value FROM meta WHERE key='updatedAt'",[],|r|r.get::<_,String>(0)).unwrap(),"before");
        for table in ["shared_tag_ops","metadata_events","deferred_fault"] {assert_eq!(reader.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get::<_,i64>(0)).unwrap(),0);}
        assert_eq!(reader.query_row("SELECT COUNT(*) FROM meta WHERE key='writerHost'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        drop(reader);drop(conn);let _=fs::remove_file(path);
    }
}

#[test]
fn shared_metadata_atomicity_signature_missing_key_compatible_but_sql_errors_fail() {
    let mut conn=Connection::open_in_memory().unwrap();initialize_shared_metadata_db(&conn).unwrap();
    assert!(shared_metadata_signature_for_transaction(&conn.transaction().unwrap()).unwrap().starts_with("metadata-v2||"));
    conn.execute_batch("INSERT INTO meta VALUES('updatedAt',X'80');").unwrap();
    assert!(shared_metadata_signature_for_transaction(&conn.transaction().unwrap()).is_err());
    assert!(super::super::signature::shared_metadata_signature_for_conn(&conn).is_ok());
    conn.execute_batch("DROP TABLE meta;").unwrap();
    assert!(shared_metadata_signature_for_transaction(&conn.transaction().unwrap()).is_err());
}
