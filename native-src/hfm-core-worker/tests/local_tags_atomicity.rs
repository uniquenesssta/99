//! Real command regression tests; no substitute SQL implementation of the mutation.
use std::{fs, path::PathBuf, process::{Command, Output}, time::{SystemTime, UNIX_EPOCH}};
use rusqlite::Connection;
use serde_json::{json, Value};

struct Fixture { dir: PathBuf, db: PathBuf }
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("hfm-atomic-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(&dir).unwrap();
        let f = Self { db: dir.join("local.sqlite"), dir };
        assert!(f.run("--local-tags-set", json!({"rows":[row("a", "old")]})).status.success());
        f.reader().execute_batch("INSERT INTO app_state VALUES ('otherDomain', '{\"favorite\":true,\"protected\":true,\"sharedTags\":[\"shared\"]}');").unwrap();
        f
    }
    fn reader(&self) -> Connection { Connection::open(&self.db).unwrap() }
    fn command(&self, mode: &str, mut payload: Value) -> Command {
        payload["dbPath"] = json!(self.db.to_str().unwrap());
        payload["updatedAt"] = json!("next");
        payload["trace"] = json!({"version":1,"sessionId":"atomic-test","operationId":"local-intent","attemptId":"attempt-1","batchId":"batch","domain":"localTags","members":["local-intent"],"omitted":0,"spanId":"span"});
        let input = self.dir.join("input.json");
        fs::write(&input, serde_json::to_vec(&payload).unwrap()).unwrap();
        let mut command = Command::new(env!("CARGO_BIN_EXE_hfm-core-worker"));
        command.arg(mode).arg("--input").arg(input);
        command
    }
    fn run(&self, mode: &str, payload: Value) -> Output { self.command(mode, payload).output().unwrap() }
    fn snapshot(&self) -> Vec<Vec<String>> {
        let conn = self.reader();
        ["SELECT font_id || '|' || font_path || '|' || tag_name || '|' || updated_at FROM local_font_tags ORDER BY 1", "SELECT key || '|' || value FROM app_state ORDER BY key", "SELECT key || '|' || value FROM meta ORDER BY key"].iter().map(|sql| {
            conn.prepare(sql).unwrap().query_map([], |r| r.get::<_, String>(0)).unwrap().map(Result::unwrap).collect()
        }).collect()
    }
}
impl Drop for Fixture { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.dir); } }
fn row(id: &str, tag: &str) -> Value { json!({"itemId":id,"aliases":[id],"fontPath":format!("{}.ttf",id),"tagNames":[tag]}) }
fn events(output: &Output) -> Vec<Value> {
    String::from_utf8_lossy(&output.stderr).lines().filter_map(|s|s.strip_prefix("operation-chain: ")).map(|s|serde_json::from_str(s).unwrap()).collect()
}
fn success(output: &Output) -> Value {
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    let e = events(output);
    assert_eq!(e.iter().map(|v|v["stage"].as_str().unwrap()).collect::<Vec<_>>(), ["backend-start", "commit", "backend-result"]);
    assert_eq!(result["stateSignal"]["trace"]["commitSequence"], e[1]["backendSequence"]);
    assert_eq!(e[2]["outcome"], "returned");
    result
}

#[test]
fn local_tags_atomicity_nth_row_catalog_and_metadata_failures() {
    for (label, trigger) in [
        ("nth-row", "CREATE TRIGGER fail BEFORE INSERT ON local_font_tags WHEN NEW.font_id='b' BEGIN SELECT RAISE(ABORT,'nth row'); END;"),
        ("catalog", "CREATE TRIGGER fail BEFORE INSERT ON app_state WHEN NEW.key='localTags' BEGIN SELECT RAISE(ABORT,'catalog'); END;"),
        ("metadata", "CREATE TRIGGER fail BEFORE INSERT ON meta WHEN NEW.key='localTagsUpdatedAt' BEGIN SELECT RAISE(ABORT,'metadata'); END;")
    ] {
        let f = Fixture::new(); let before = f.snapshot();
        f.reader().execute_batch(trigger).unwrap();
        let output = f.run("--local-tags-set", json!({"rows":[row("a","new"),row("b","new")]}));
        assert!(!output.status.success(), "{}", label);
        assert_eq!(f.snapshot(), before, "{} leaked partial writes", label);
        let e = events(&output);
        assert_eq!(e.len(), 2); assert_eq!(e[0]["stage"], "backend-start");
        assert_eq!(e[1]["outcome"], "unknown");
        assert!(!e.iter().any(|v| v["stage"]=="commit"));
    }
}

#[test]
fn local_tags_atomicity_delete_failure_is_atomic() {
    for trigger in [
        "CREATE TRIGGER fail BEFORE INSERT ON app_state WHEN NEW.key='localTags' BEGIN SELECT RAISE(ABORT,'catalog'); END;",
        "CREATE TRIGGER fail BEFORE INSERT ON meta WHEN NEW.key='localTagsUpdatedAt' BEGIN SELECT RAISE(ABORT,'metadata'); END;"
    ] {
        let f = Fixture::new(); let before = f.snapshot(); f.reader().execute_batch(trigger).unwrap();
        let output = f.run("--local-tags-delete-tag", json!({"tagName":"old"}));
        assert!(!output.status.success()); assert_eq!(f.snapshot(), before);
        assert!(!events(&output).iter().any(|v| v["stage"]=="commit"));
    }
}

#[test]
fn local_tags_atomicity_success_empty_duplicate_and_catalog_contracts() {
    let f = Fixture::new(); let other = f.snapshot()[1].iter().find(|s|s.starts_with("otherDomain|")).unwrap().clone();
    let result = success(&f.run("--local-tags-set", json!({"rows":[row("a","new"),row("a","new"),row("b","new")]})));
    assert_eq!(result["updatedIds"], json!(["a","b"])); assert_eq!(result["written"], 3);
    assert_eq!(result["retainedEmptyTags"], json!(["old"]));
    assert_eq!(result["knownTags"], json!(["new","old"]));
    assert_eq!(f.snapshot()[0].len(), 2);
    let before = f.snapshot();
    let unchanged = success(&f.run("--local-tags-set", json!({"rows":[row("a","new")]})));
    assert_eq!(unchanged["addedKnownTags"], json!([]));
    assert_eq!(unchanged["removedKnownTags"], json!([]));
    assert_eq!(f.snapshot(), before);
    let empty = success(&f.run("--local-tags-set", json!({"rows":[]})));
    assert_eq!(empty["updatedIds"], json!([])); assert_eq!(f.snapshot(), before);
    let blank = success(&f.run("--local-tags-delete-tag", json!({"tagName":" "})));
    assert_eq!(blank["updated"], 0); assert_eq!(f.snapshot(), before);
    let deleted = success(&f.run("--local-tags-delete-tag", json!({"tagName":"new"})));
    assert_eq!(deleted["updatedIds"], json!(["a","b"])); assert_eq!(deleted["knownTags"], json!(["old"]));
    assert!(f.snapshot()[0].is_empty());
    let removed_empty = success(&f.run("--local-tags-delete-tag", json!({"tagName":"old"})));
    assert_eq!(removed_empty["knownTags"], json!([]));
    assert_eq!(f.reader().query_row("SELECT value FROM app_state WHERE key='localTags'",[],|r|r.get::<_,String>(0)).unwrap(), "[]");
    assert!(f.snapshot()[1].contains(&other));
}

#[cfg(unix)]
#[test]
fn local_tags_atomicity_logging_io_failure_does_not_replay_or_fail_commit() {
    let f = Fixture::new();
    let output = f.command("--local-tags-set", json!({"rows":[row("a","new")]}))
        .stderr(fs::OpenOptions::new().write(true).open("/dev/full").unwrap()).output().unwrap();
    assert!(output.status.success());
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["ok"], true); assert_eq!(result["stateSignal"]["trace"]["commitSequence"], 2);
    assert_eq!(f.snapshot()[0], vec!["a|a.ttf|new|next"]);
}
