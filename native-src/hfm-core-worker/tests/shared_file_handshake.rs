use serde_json::{json, Value};
use std::{fs, path::PathBuf, process::Command, time::{Duration, SystemTime, UNIX_EPOCH}};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}
fn worker(args: &[&str]) -> Value {
    let output = Command::new(env!("CARGO_BIN_EXE_hfm-core-worker")).args(args).output().unwrap();
    assert!(output.status.success(), "worker failed: {:?}", output);
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn advertised_shared_file_capability_reaches_real_command() {
    let handshake = worker(&["--handshake"]);
    assert_eq!(handshake["ok"], true);
    let capabilities = handshake["capabilities"].as_array().unwrap();
    assert!(capabilities.contains(&json!("shared-file-io-v1")), "real handshake omitted shared file capability");
    // Read the actual Electron admission requirements, not a synthetic handshake fixture.
    let admission = include_str!("../../../src/main/rust-core/rustCoreProtocolRuntime.ts");
    let required = admission.split("REQUIRED_RUST_CORE_CAPABILITIES = [").nth(1).unwrap().split("] as const").next().unwrap();
    for line in required.lines() {
        if let Some(capability) = line.trim().strip_prefix('\'').and_then(|s| s.split('\'').next()) {
            assert!(capabilities.contains(&json!(capability)), "missing startup capability: {capability}");
        }
    }
    let dir = Fixture(std::env::temp_dir().join(format!("hfm-handshake-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos())));
    fs::create_dir_all(&dir.0).unwrap();
    let source = dir.0.join("中文 공유 字体.bin");
    let input = dir.0.join("input.json");
    let transfer = dir.0.join("transfer.bin");
    let bytes = [0, 255, 128, 1, 10];
    fs::write(&source, bytes).unwrap();
    let before_epoch = UNIX_EPOCH.checked_sub(Duration::from_secs(1)).unwrap();
    fs::File::options().write(true).open(&source).unwrap()
        .set_times(fs::FileTimes::new().set_modified(before_epoch)).unwrap();

    fs::write(&input, json!({"operation":"treeSnapshot","path":dir.0,"availabilityRoot":dir.0}).to_string()).unwrap();
    let snapshot = worker(&["--shared-file-io", "--input", input.to_str().unwrap()]);
    assert_eq!(snapshot["ok"], true, "{snapshot}");
    let old_timestamp = snapshot["value"]["中文 공유 字体.bin"][1].as_str().unwrap();
    assert!(old_timestamp.starts_with('-'), "pre-epoch modification time lost its sign: {snapshot}");

    for operation in ["stat", "readFile"] {
        fs::write(&input, json!({"operation":operation,"path":source,"availabilityRoot":dir.0,"transferPath":transfer}).to_string()).unwrap();
        let result = worker(&["--shared-file-io", "--input", input.to_str().unwrap()]);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(result["operation"], operation);
        if operation == "stat" {
            assert_eq!(result["value"]["size"], bytes.len());
            assert!(result["value"]["mtimeMs"].as_f64().unwrap() < 0.0, "pre-epoch stat timestamp was not preserved: {result}");
        } else { assert_eq!(fs::read(&transfer).unwrap(), bytes); }
    }
    let stale = dir.0.join("pre-epoch.lock");
    fs::write(&stale, b"lock").unwrap();
    fs::File::options().write(true).open(&stale).unwrap()
        .set_times(fs::FileTimes::new().set_modified(before_epoch)).unwrap();
    fs::write(&input, json!({"operation":"removeStaleLock","path":stale,"availabilityRoot":dir.0,"olderThanMs":0}).to_string()).unwrap();
    let removed = worker(&["--shared-file-io", "--input", input.to_str().unwrap()]);
    assert_eq!(removed["ok"], true, "{removed}");
    assert_eq!(removed["value"], true, "{removed}");
    assert!(!stale.exists());

    fs::remove_file(&source).unwrap();
    fs::write(&input, json!({"operation":"readFile","path":source,"availabilityRoot":dir.0,"transferPath":transfer}).to_string()).unwrap();
    let missing = worker(&["--shared-file-io", "--input", input.to_str().unwrap()]);
    assert_eq!(missing["ok"], false);
    assert_eq!(missing["code"], "ENOENT");
}
