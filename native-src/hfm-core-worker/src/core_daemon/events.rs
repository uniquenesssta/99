use std::io::{self, Write};
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::json::escape_json;

pub type SharedStdout = Arc<Mutex<io::Stdout>>;

pub fn error_json(message: &str) -> String {
    format!(
        "{{\"ok\":false,\"message\":\"{}\",\"workerMode\":\"rust-core-daemon-job-runtime\"}}",
        escape_json(message)
    )
}

pub fn emit_event(stdout: &SharedStdout, event: Value) {
    if let Ok(mut handle) = stdout.lock() {
        let _ = writeln!(handle, "{}", event);
        let _ = handle.flush();
    }
}
