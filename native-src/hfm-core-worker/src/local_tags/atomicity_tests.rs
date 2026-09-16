use super::*;
use serde_json::json;

#[test]
fn local_tags_atomicity_commit_failure_rolls_back_both_commands() {
    for delete in [false, true] {
        let path = std::env::temp_dir().join(format!("hfm-commit-{}-{}-{}.sqlite", std::process::id(), delete, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let mut conn = Connection::open(&path).unwrap();
        initialize_local_tags_db(&conn).unwrap();
        conn.execute_batch("INSERT INTO local_font_tags VALUES ('a','a.ttf','old','before');
            INSERT INTO app_state VALUES ('localTags','[\"old\"]');
            INSERT INTO meta VALUES ('localTagsUpdatedAt','before');
            PRAGMA foreign_keys=ON;
            CREATE TABLE parent(id INTEGER PRIMARY KEY);
            CREATE TABLE deferred_fault(id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED);
            CREATE TRIGGER fail_at_commit AFTER INSERT ON meta WHEN NEW.key='localTagsUpdatedAt'
            BEGIN INSERT INTO deferred_fault VALUES(1); END;").unwrap();
        let mut trace = crate::operation_trace::OperationTrace::from_input(&json!({"trace":{"version":1,"sessionId":"commit-test","operationId":"intent","attemptId":"attempt","batchId":"batch","domain":"localTags"}}).to_string());
        let result = if delete {
            delete_on_connection(&mut conn, &serde_json::from_value(json!({"dbPath":path.to_str().unwrap(),"updatedAt":"next","tagName":"old"})).unwrap(), &mut trace, Instant::now())
        } else {
            set_on_connection(&mut conn, &serde_json::from_value(json!({"dbPath":path.to_str().unwrap(),"updatedAt":"next","rows":[{"itemId":"a","aliases":["a"],"fontPath":"a.ttf","tagNames":["new"]}]})).unwrap(), &mut trace, Instant::now())
        };
        assert!(result.unwrap_err().contains("FOREIGN KEY constraint failed"));
        assert!(trace.context.as_ref().unwrap().get("commitSequence").is_none());
        assert!(conn.is_autocommit());
        let reader = Connection::open(&path).unwrap();
        for (sql, expected) in [
            ("SELECT tag_name FROM local_font_tags WHERE font_id='a'", "old"),
            ("SELECT value FROM app_state WHERE key='localTags'", "[\"old\"]"),
            ("SELECT value FROM meta WHERE key='localTagsUpdatedAt'", "before")
        ] { assert_eq!(reader.query_row(sql, [], |r|r.get::<_,String>(0)).unwrap(), expected); }
        assert_eq!(reader.query_row("SELECT COUNT(*) FROM deferred_fault",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        drop(reader); drop(conn); let _=fs::remove_file(path);
    }
}
