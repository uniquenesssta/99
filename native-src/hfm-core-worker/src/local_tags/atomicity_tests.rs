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
            INSERT INTO local_font_legacy_state(kind,font_id,tag_name,payload_json) VALUES ('tag','historical','old','{}');
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
        assert_eq!(reader.query_row("SELECT COUNT(*) FROM local_font_tag_decisions",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(reader.query_row("SELECT status FROM local_font_legacy_state WHERE font_id='historical'",[],|r|r.get::<_,String>(0)).unwrap(),"pending");
        drop(reader); drop(conn); let _=fs::remove_file(path);
    }
}

#[test]
fn local_tags_path_writes_preserve_other_copies() {
    let mut conn = Connection::open_in_memory().unwrap();
    initialize_local_tags_db(&conn).unwrap();
    conn.execute_batch(r"INSERT INTO local_font_tags VALUES ('shared','c:\one.ttf','old','before');").unwrap();
    for (path, tags) in [(r"c:\two.ttf", vec!["two"]), (r"c:\one.ttf", vec!["one"]), (r"c:\one.ttf", vec![])] {
        let mut trace = crate::operation_trace::OperationTrace::from_input("{}");
        let payload = serde_json::from_value(json!({"dbPath":"test","updatedAt":"next",
            "rows":[{"itemId":"shared","aliases":["shared"],"fontPath":path,"tagNames":tags}]})).unwrap();
        set_on_connection(&mut conn, &payload, &mut trace, Instant::now()).unwrap();
        let count: i64 = conn.query_row(r"SELECT COUNT(*) FROM local_font_tags WHERE font_path='c:\two.ttf' AND tag_name='two'", [], |r|r.get(0)).unwrap();
        assert_eq!(count, 1);
    }
    assert_eq!(conn.query_row("SELECT COUNT(*) FROM local_font_tags", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
}

#[test]
fn recovery_tag_conflict_rolls_back_entire_batch_and_state() {
    for conflict in [false, true] {
        let mut conn = Connection::open_in_memory().unwrap();
        initialize_local_tags_db(&conn).unwrap();
        conn.execute_batch(r"INSERT INTO local_font_tags VALUES ('old','c:\old.ttf','Keep','before');
          CREATE TABLE local_font_favorites(font_id TEXT PRIMARY KEY,font_path TEXT,favorite INTEGER);
          INSERT INTO local_font_favorites VALUES ('source','c:\old.ttf',1);
          INSERT INTO local_font_favorites VALUES ('legacy-target','c:\new.ttf',0);
          CREATE TABLE local_font_protection(font_path TEXT PRIMARY KEY,protected INTEGER);
          INSERT INTO local_font_protection VALUES ('c:\old.ttf',1);").unwrap();
        let payload = serde_json::from_value(json!({"dbPath":"test","updatedAt":"after","rows":[
          {"itemId":"new","aliases":["new"],"fontPath":r"c:\new.ttf","tagNames":["Keep"],"expectedTagNames":[]},
          {"itemId":"old","aliases":["old"],"fontPath":r"c:\old.ttf","tagNames":[],"expectedTagNames":if conflict {vec!["Changed"]} else {vec!["Keep"]}}
        ],"recoveryMoves":[{"from":r"c:\old.ttf","to":r"c:\new.ttf"}]})).unwrap();
        let mut trace = crate::operation_trace::OperationTrace::from_input("{}");
        let result=set_on_connection(&mut conn,&payload,&mut trace,Instant::now());
        assert_eq!(result.is_err(), conflict);
        assert_eq!(conn.query_row(r"SELECT COUNT(*) FROM local_font_tags WHERE font_path='c:\old.ttf'", [], |r|r.get::<_,i64>(0)).unwrap(), if conflict {1} else {0});
        assert_eq!(conn.query_row(r"SELECT COUNT(*) FROM local_font_tags WHERE font_path='c:\new.ttf'", [], |r|r.get::<_,i64>(0)).unwrap(), if conflict {0} else {1});
        assert_eq!(conn.query_row(r"SELECT COUNT(*) FROM local_font_protection WHERE font_path='c:\new.ttf'", [], |r|r.get::<_,i64>(0)).unwrap(), if conflict {0} else {1});
        assert_eq!(conn.query_row(r"SELECT favorite FROM local_font_favorites WHERE font_path='c:\new.ttf'", [], |r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(conn.query_row(r"SELECT COUNT(*) FROM local_font_favorites WHERE font_path='c:\new.ttf'", [], |r|r.get::<_,i64>(0)).unwrap(),1);
    }
}

#[test]
#[cfg(windows)]
fn recovery_target_is_pinned_and_changed_content_is_rejected() {
    let dir=std::env::temp_dir().join(format!("hfm-recovery-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    std::fs::create_dir(&dir).unwrap();
    let target=dir.join("target.ttf");
    let mut bytes=vec![0u8;100];bytes[1]=1;
    std::fs::write(&target,&bytes).unwrap();
    let path=target.to_string_lossy().into_owned();
    // Mirror main-process realpath evidence; TEMP can contain aliases/short names.
    let physical=std::fs::canonicalize(&target).unwrap().to_string_lossy().into_owned();
    let expected="16b1d4dcb432a18c4511ff04d5af0786937fd6d3e38a5bfca703132654e85073";
    let wrong_target=dir.join("other.ttf").to_string_lossy().into_owned();
    let wrong=crate::font_mutation::pin_recovery_file(&path,&wrong_target,expected).unwrap_err();
    assert!(wrong.to_string().contains("physical path"),"different physical target must stay rejected");
    let aliased=dir.join(".").join("target.ttf").to_string_lossy().into_owned();
    let pin=crate::font_mutation::pin_recovery_file(&aliased,&physical,expected).unwrap();
    assert!(std::fs::write(&target,&bytes).is_err(),"target writes must stay blocked during commit");
    assert!(std::fs::rename(&target,dir.join("moved.ttf")).is_err(),"target replacement must stay blocked during commit");
    drop(pin);
    bytes[99]=1;std::fs::write(&target,&bytes).unwrap();
    let changed=crate::font_mutation::pin_recovery_file(&path,&physical,expected).unwrap_err();
    assert!(changed.to_string().contains("content"),"same-size changed bytes must be rejected by content evidence");
    std::fs::remove_dir_all(&dir).unwrap();
}


#[test]
fn local_tags_extended_storage_updates_and_removes_only_exact_file() {
    for (extended,canonical) in [(r"\?\unc\server\share\one.ttf",r"\server\share\one.ttf"),(r"\?\c:\fonts\one.ttf",r"c:\fonts\one.ttf")] {
        let mut conn=Connection::open_in_memory().unwrap();initialize_local_tags_db(&conn).unwrap();
        conn.execute("INSERT INTO local_font_tags VALUES ('old',?,'Old','before')",[extended]).unwrap();
        conn.execute("INSERT INTO local_font_tags VALUES ('other',?,'Unrelated','before')",[format!("{canonical}.other")]).unwrap();
        for conflict in [true,false] {
            let payload=serde_json::from_value(json!({"dbPath":"test","updatedAt":"after","rows":[
                {"itemId":"new","aliases":["new"],"fontPath":canonical,"tagNames":["New"],"expectedTagNames":if conflict {vec!["Changed"]} else {vec!["Old"]}}
            ]})).unwrap();
            let mut trace=crate::operation_trace::OperationTrace::from_input("{}");
            assert_eq!(set_on_connection(&mut conn,&payload,&mut trace,Instant::now()).is_err(),conflict);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM local_font_tags WHERE font_path=?",[extended],|r|r.get::<_,i64>(0)).unwrap(),if conflict {1} else {0});
        }
        let payload=serde_json::from_value(json!({"dbPath":"test","updatedAt":"removed","rows":[
            {"itemId":"new","aliases":["new"],"fontPath":extended,"tagNames":[],"expectedTagNames":["New"]}
        ]})).unwrap();
        let mut trace=crate::operation_trace::OperationTrace::from_input("{}");
        set_on_connection(&mut conn,&payload,&mut trace,Instant::now()).unwrap();
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM local_font_tags",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(conn.query_row("SELECT tag_name FROM local_font_tags",[],|r|r.get::<_,String>(0)).unwrap(),"Unrelated");
    }
}
