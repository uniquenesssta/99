//! Opt-in, fail-fast investigation. This deliberately changes lock-wait behavior
//! and must not be used as production correctness or timing acceptance evidence.
use std::io::{self, Write};
use rusqlite::{backup::StepResult, Connection};
use serde_json::json;

#[derive(Clone, Copy)]
pub(super) enum SyntheticOutcome { Busy, Locked, Integrity }

fn emit(event: &'static str, role: &'static str, phase: &'static str,
        attempt: Option<i32>, outcome: Option<&'static str>, codes: Option<(i32, i32)>) {
    let (primary, extended) = match codes {
        Some((primary, extended)) => (Some(primary), Some(extended)),
        None => (None, None),
    };
    let value = json!({
        "version": 1, "feature": "snapshot-busy-diagnostic",
        "event": event, "role": role, "phase": phase, "attempt": attempt,
        "outcome": outcome, "primaryCode": primary, "extendedCode": extended,
    });
    // Broken diagnostic pipes must not panic or alter the operation's error.
    let _ = writeln!(io::stderr().lock(), "hfm-snapshot-busy: {value}");
}

pub(super) fn begin() { emit("begin", "unknown", "copy", None, None, None); }

pub(super) fn phase(phase: &'static str) {
    emit("phase", "unknown", phase, None, None, None);
}

fn source_busy(attempt: i32) -> bool {
    if attempt == 0 { emit("busy-handler", "source", "copy", Some(0), Some("busy"), None); }
    false
}

fn destination_busy(attempt: i32) -> bool {
    if attempt == 0 { emit("busy-handler", "destination", "copy", Some(0), Some("busy"), None); }
    false
}

pub(super) fn install_source(source: &Connection) -> rusqlite::Result<()> {
    source.busy_handler(Some(source_busy))
}

pub(super) fn install_destination(destination: &Connection) -> rusqlite::Result<()> {
    destination.busy_handler(Some(destination_busy))
}

fn sqlite_failure(error: &rusqlite::Error) -> (&'static str, Option<(i32, i32)>) {
    match error {
        rusqlite::Error::SqliteFailure(code, _) =>
            ("sqlite-error", Some((code.extended_code & 255, code.extended_code))),
        _ => ("other-error", None),
    }
}

pub(super) fn step(result: &rusqlite::Result<StepResult>) {
    let (outcome, codes) = match result {
        Ok(StepResult::Done) => ("done", None),
        Ok(StepResult::Busy) => ("busy", None),
        Ok(StepResult::Locked) => ("locked", None),
        Ok(StepResult::More) => ("more", None),
        Ok(_) => ("other-error", None),
        Err(error) => sqlite_failure(error),
    };
    // StepResult is the original API result, not our later synthesized io error.
    // Do not call any connection API here to guess an extended result code.
    emit("backup-step", "unknown", "after-step", None, Some(outcome), codes);
}

pub(super) fn result(result: &io::Result<()>, synthetic: Option<SyntheticOutcome>) {
    let (outcome, codes) = match result {
        Ok(()) => ("ok", None),
        Err(error) => match synthetic {
            Some(SyntheticOutcome::Busy) => ("busy", None),
            Some(SyntheticOutcome::Locked) => ("locked", None),
            Some(SyntheticOutcome::Integrity) => ("other-error", None),
            None => match error.get_ref().and_then(|inner| inner.downcast_ref::<rusqlite::Error>()) {
                Some(error) => sqlite_failure(error),
                None => ("other-error", None),
            },
        },
    };
    emit("result", "unknown", "copy", None, Some(outcome), codes);
}
