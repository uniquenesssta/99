use std::fs;
use std::process::{Command, Output};
use std::time::{SystemTime, UNIX_EPOCH};
use rusqlite::Connection;
use serde_json::{json, Value};

#[test]
fn operation_trace_real_worker_commit_and_failure() {
    let dir = std::env::temp_dir().join(format!("hfm-trace-test-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&dir).unwrap();
    let db_path = dir.join("local.sqlite");
    let input_path = dir.join("input.json");
    let trace = json!({"version":1,"sessionId":"native-test","operationId":"intent","attemptId":"attempt-1","batchId":"batch","domain":"localTags","members":["intent"],"omitted":0,"spanId":"span"});
    let run = |tag: &str, trace: Value| -> Output {
        fs::write(&input_path, serde_json::to_vec(&json!({"dbPath":db_path.to_str().unwrap(),"updatedAt":"2026-09-16T00:00:00Z","rows":[{"itemId":"a","aliases":["a"],"fontPath":"a.ttf","tagNames":[tag]}],"trace":trace})).unwrap()).unwrap();
        Command::new(env!("CARGO_BIN_EXE_hfm-core-worker")).arg("--local-tags-set").arg("--input").arg(&input_path).output().unwrap()
    };
    let events = |output: &Output| -> Vec<Value> {
        String::from_utf8_lossy(&output.stderr).lines().filter_map(|line| line.strip_prefix("operation-chain: ")).map(|line|serde_json::from_str(line).unwrap()).collect()
    };
    let success = run("old", trace.clone());
    assert!(success.status.success(), "{}", String::from_utf8_lossy(&success.stdout));
    let result: Value = serde_json::from_slice(&success.stdout).unwrap();
    let mut committed_trace = trace.clone(); committed_trace["commitSequence"] = json!(2);
    assert_eq!(result["stateSignal"]["trace"], committed_trace);
    let e = events(&success);
    assert_eq!(e.iter().map(|e|e["stage"].as_str().unwrap()).collect::<Vec<_>>(), vec!["backend-start","commit","backend-result"]);
    let reader = Connection::open(&db_path).unwrap();
    assert_eq!(reader.query_row("SELECT tag_name FROM local_font_tags WHERE font_id='a'", [], |row|row.get::<_,String>(0)).unwrap(), "old");
    reader.execute_batch("CREATE TRIGGER fail_before_write BEFORE INSERT ON local_font_tags BEGIN SELECT RAISE(ABORT, 'fault'); END;").unwrap();
    let failed = run("new", trace.clone());
    assert!(!failed.status.success());
    assert!(!events(&failed).iter().any(|e|e["stage"]=="commit"));
    assert_eq!(reader.query_row("SELECT tag_name FROM local_font_tags WHERE font_id='a'", [], |row|row.get::<_,String>(0)).unwrap(), "old");
    reader.execute_batch("DROP TRIGGER fail_before_write; CREATE TRIGGER fail_catalog BEFORE INSERT ON app_state WHEN NEW.key='localTags' BEGIN SELECT RAISE(ABORT, 'catalog fault'); END;").unwrap();
    let late_failure = run("new", trace.clone());
    assert!(!late_failure.status.success());
    let persisted = reader.query_row("SELECT tag_name FROM local_font_tags WHERE font_id='a'", [], |row|row.get::<_,String>(0)).unwrap()=="new";
    // Observability follows the actual DB outcome; R-02 may move the catalog into the transaction.
    let late_events=events(&late_failure);
    assert_eq!(late_events.iter().any(|e|e["stage"]=="commit"),persisted);
    if persisted { assert!(late_events.iter().any(|e|e["outcome"]=="committed-error")); }
    reader.execute_batch("DROP TRIGGER fail_catalog;").unwrap();
    let legacy=run("legacy",Value::Null);assert!(legacy.status.success());assert!(events(&legacy).is_empty());
    drop(reader);fs::remove_dir_all(dir).unwrap();
}
