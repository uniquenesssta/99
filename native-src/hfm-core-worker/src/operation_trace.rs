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

pub struct OperationTrace {
    pub context: Option<Value>,
    committed: bool,
    returned: bool,
    sequence: Cell<u64>,
    started: Instant,
}
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
            let event = json!({"trace": context, "stage": stage, "outcome": outcome, "reason": reason, "backend": "rust", "backendSequence": self.sequence.get(), "elapsedMs": self.started.elapsed().as_millis()});
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
