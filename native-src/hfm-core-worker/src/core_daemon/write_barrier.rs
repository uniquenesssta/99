use std::thread;
use std::time::{Duration, Instant};

use super::events::SharedStdout;
use super::progress::emit_progress;
use super::state::{has_earlier_write_jobs, record_metadata_barrier_wait, SharedDaemonState};
use super::types::DaemonLane;

const WRITE_BARRIER_POLL_MS: u64 = 5;
const WRITE_BARRIER_TIMEOUT_MS: u128 = 5_000;

pub fn command_requires_metadata_write_barrier(command: &str) -> bool {
    matches!(
        command,
        "--merged-index-query-page"
            | "--merged-index-query-metrics"
            | "--merged-index-query-ids"
            | "--shared-metadata-signature"
            | "--shared-metadata-known-tags"
            | "--shared-metadata-overlay-read"
            | "--local-tags-read"
    )
}

pub fn wait_for_metadata_write_barrier(
    state: &SharedDaemonState,
    stdout: &SharedStdout,
    id: &str,
    command: &str,
    lane: DaemonLane,
    sequence: u64,
) -> u128 {
    if lane == DaemonLane::Write || !command_requires_metadata_write_barrier(command) {
        return 0;
    }

    let started = Instant::now();
    let mut emitted_wait = false;
    while has_earlier_write_jobs(state, sequence) {
        if !emitted_wait {
            emitted_wait = true;
            emit_progress(stdout, id, command, lane, "metadata_write_barrier_wait", 6, None);
        }
        if started.elapsed().as_millis() >= WRITE_BARRIER_TIMEOUT_MS {
            record_metadata_barrier_wait(state, true);
            emit_progress(
                stdout,
                id,
                command,
                lane,
                "metadata_write_barrier_timeout",
                8,
                Some(started.elapsed().as_millis() as u64),
            );
            return started.elapsed().as_millis();
        }
        thread::sleep(Duration::from_millis(WRITE_BARRIER_POLL_MS));
    }

    let elapsed = started.elapsed().as_millis();
    if emitted_wait {
        record_metadata_barrier_wait(state, false);
        emit_progress(
            stdout,
            id,
            command,
            lane,
            "metadata_write_barrier_released",
            8,
            Some(elapsed as u64),
        );
    }
    elapsed
}
