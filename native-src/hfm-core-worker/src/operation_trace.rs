//! Diagnostic-only command scope. No database state, global store or replay policy.
use serde_json::{json, Value};
use serde::Deserialize;

#[derive(Deserialize)]
struct TraceInput { trace: Option<Value> }
use std::io::{self, Write};
use std::cell::Cell;
use std::time::Instant;

fn token(value: &Value) -> bool {
    value.as_str().map(|s| !s.is_empty() && s.len() <= 96 && s.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.:-".contains(&c))).unwrap_or(false)
}
fn clean(value: &Value) -> Option<Value> {
    if value.get("version")?.as_u64()? != 1 { return None; }
    let mut out = json!({"version": 1});
    for key in ["sessionId", "operationId", "attemptId", "batchId", "domain"] {
        if !token(&value[key]) { return None; }
        out[key] = value[key].clone();
    }
    if token(&value["target"]) { out["target"] = value["target"].clone(); }
    if value["rendererGeneration"].as_u64().is_some() { out["rendererGeneration"] = value["rendererGeneration"].clone(); }
    if token(&value["spanId"]) { out["spanId"] = value["spanId"].clone(); }
    let members = value["members"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    out["members"] = Value::Array(members.iter().take(16).filter(|v| token(v)).cloned().collect());
    out["omitted"] = json!(value["omitted"].as_u64().unwrap_or(0).min(1_000_000_000) + members.len().saturating_sub(out["members"].as_array().map(Vec::len).unwrap_or(0)) as u64);
    Some(out)
}

#[cfg(windows)]
mod process_identity {
    use crate::windows_ffi::{FileTime, Handle};
    use serde_json::{json, Value};

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcess() -> Handle;
        fn GetProcessTimes(process: Handle, created: *mut FileTime, exited: *mut FileTime,
            kernel: *mut FileTime, user: *mut FileTime) -> i32;
    }

    pub(super) fn current() -> Value {
        let mut created = FileTime::default();
        let mut exited = FileTime::default();
        let mut kernel = FileTime::default();
        let mut user = FileTime::default();
        // The pseudo handle refers to this process and needs no CloseHandle.
        // All output pointers refer to distinct, live FILETIME-sized values.
        let succeeded = unsafe {
            GetProcessTimes(GetCurrentProcess(), &mut created, &mut exited, &mut kernel, &mut user)
        };
        let creation_file_time = if succeeded != 0 {
            // Preserve all 64 bits for the observer's retained-handle match.
            // Never serialize this identity as a JSON/JavaScript number.
            (((created.high as u64) << 32) | created.low as u64).to_string()
        } else {
            "unknown".to_owned()
        };
        json!({"pid": std::process::id(), "creationFileTime": creation_file_time})
    }
}

pub struct OperationTrace {
    pub context: Option<Value>,
    committed: bool,
    returned: bool,
    sequence: Cell<u64>,
    started: Instant,
}
// Fixed diagnostic vocabulary only. No input path, SQL or error text is emitted.
pub enum SnapshotPhase { TargetCheck, OpenStart, Opened, TargetOpenStart, TargetOpened, BackupStart, BackupReturned, IntegrityStart, IntegrityReturned, TargetCloseReturned, ConnectionDropReturned, ErrorMapStart, ErrorMapReturned }
impl OperationTrace {
    pub fn from_input(input: &str) -> Self {
        let context = serde_json::from_str::<TraceInput>(input).ok().and_then(|v| v.trace.as_ref().and_then(clean));
        let trace = Self { context, committed: false, returned: false, sequence: Cell::new(0), started: Instant::now() };
        trace.emit("backend-start", "running", "command-entered");
        trace
    }
    fn emit(&self, stage: &str, outcome: &str, reason: &str) {
        self.sequence.set(self.sequence.get() + 1);
        if let Some(context) = &self.context {
            let mut event = json!({"trace": context, "stage": stage, "outcome": outcome, "reason": reason, "backend": "rust", "backendSequence": self.sequence.get(), "elapsedMs": self.started.elapsed().as_millis()});
            #[cfg(windows)]
            if reason == "command-entered"
                && context["sessionId"].as_str() == Some("private-snapshot-ci")
                && context["domain"].as_str() == Some("sqliteSnapshot")
                && std::env::var("HFM_SNAPSHOT_PROCESS_COUNTERS").ok().as_deref() == Some("1")
            {
                event["processIdentity"] = process_identity::current();
            }
            if let Ok(encoded) = serde_json::to_string(&event) {
                if encoded.len() <= 8192 {
                    // Ignore stderr errors; logging can never change a transaction result.
                    let _ = writeln!(io::stderr().lock(), "operation-chain: {}", encoded);
                }
            }
        }
    }
    pub fn committed(&mut self) {
        self.committed = true;
        if let Some(context) = &mut self.context { context["commitSequence"] = json!(self.sequence.get() + 1); }
        self.emit("commit", "committed", "transaction-only-metadata-may-follow");
    }
    pub fn snapshot_phase(&self, phase: SnapshotPhase) {
        let reason = match phase {
            SnapshotPhase::TargetCheck => "snapshot-target-check",
            SnapshotPhase::OpenStart => "snapshot-open-start",
            SnapshotPhase::Opened => "snapshot-opened",
            SnapshotPhase::TargetOpenStart => "snapshot-target-open-start",
            SnapshotPhase::TargetOpened => "snapshot-target-opened",
            SnapshotPhase::BackupStart => "snapshot-backup-start",
            SnapshotPhase::BackupReturned => "snapshot-backup-returned",
            SnapshotPhase::IntegrityStart => "snapshot-integrity-start",
            SnapshotPhase::IntegrityReturned => "snapshot-integrity-returned",
            SnapshotPhase::TargetCloseReturned => "snapshot-target-close-returned",
            SnapshotPhase::ConnectionDropReturned => "snapshot-connection-drop-returned",
            SnapshotPhase::ErrorMapStart => "snapshot-error-map-start",
            SnapshotPhase::ErrorMapReturned => "snapshot-error-map-returned",
        };
        self.emit("backend-phase", "running", reason);
    }
    pub fn finish(&mut self, result: Result<String, String>) -> Result<String, String> {
        self.returned = true;
        self.emit("backend-result", if result.is_ok() { "returned" } else if self.committed { "committed-error" } else { "unknown" }, "command-result");
        result
    }
}
impl Drop for OperationTrace {
    fn drop(&mut self) {
        if !self.returned {
            self.emit("backend-result", if self.committed { "committed-error" } else { "unknown" }, "early-return-no-rollback-claim");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operation_trace_legacy_and_bounds() {
        assert!(OperationTrace::from_input("{}").context.is_none());
        assert!(OperationTrace::from_input("bad-json").context.is_none());
        let value = json!({"version":1,"sessionId":"s","operationId":"o","attemptId":"a","batchId":"b","domain":"localTags","members":vec!["o"; 20],"secret":"must-not-leak"});
        let clean = clean(&value).unwrap();
        assert_eq!(clean["members"].as_array().unwrap().len(), 16);
        assert_eq!(clean["omitted"], 4);
        assert!(clean.get("secret").is_none());
    }
}
