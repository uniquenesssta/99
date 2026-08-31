use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use super::types::{all_daemon_lanes, DaemonLane};

#[derive(Clone, Debug)]
struct DaemonJobState {
    id: String,
    command: String,
    lane: DaemonLane,
    sequence: u64,
}

#[derive(Debug, Default)]
pub struct DaemonState {
    next_sequence: u64,
    queued: Vec<DaemonJobState>,
    running: Vec<DaemonJobState>,
    completed: u64,
    cancelled: u64,
    failed: u64,
    rejected: u64,
    metadata_barrier_waits: u64,
    metadata_barrier_timeouts: u64,
}

pub type SharedDaemonState = Arc<Mutex<DaemonState>>;
pub type CancelSet = Arc<Mutex<HashSet<String>>>;

pub fn new_shared_state() -> SharedDaemonState {
    Arc::new(Mutex::new(DaemonState::default()))
}

pub fn new_cancel_set() -> CancelSet {
    Arc::new(Mutex::new(HashSet::new()))
}

pub fn queued_len_for_lane(state: &SharedDaemonState, lane: DaemonLane) -> usize {
    match state.lock() {
        Ok(state) => state.queued.iter().filter(|job| job.lane == lane).count(),
        Err(_) => 0,
    }
}

pub fn enqueue(state: &SharedDaemonState, id: &str, command: &str, lane: DaemonLane) -> u64 {
    match state.lock() {
        Ok(mut state) => {
            state.next_sequence = state.next_sequence.saturating_add(1);
            let sequence = state.next_sequence;
            state.queued.push(DaemonJobState {
                id: id.to_string(),
                command: command.to_string(),
                lane,
                sequence,
            });
            sequence
        }
        Err(_) => 0,
    }
}

pub fn reject_enqueue(state: &SharedDaemonState) {
    if let Ok(mut state) = state.lock() {
        state.rejected += 1;
        state.failed += 1;
    }
}

pub fn start(state: &SharedDaemonState, id: &str, command: &str, lane: DaemonLane, sequence: u64) {
    if let Ok(mut state) = state.lock() {
        state.queued.retain(|job| job.id != id);
        state.running.push(DaemonJobState {
            id: id.to_string(),
            command: command.to_string(),
            lane,
            sequence,
        });
    }
}

pub fn finish(state: &SharedDaemonState, id: &str, ok: bool) {
    if let Ok(mut state) = state.lock() {
        state.running.retain(|job| job.id != id);
        if ok {
            state.completed += 1;
        } else {
            state.failed += 1;
        }
    }
}

pub fn cancel_before_start(state: &SharedDaemonState, id: &str) {
    if let Ok(mut state) = state.lock() {
        state.queued.retain(|job| job.id != id);
        state.cancelled += 1;
    }
}

pub fn cancel_after_start(state: &SharedDaemonState, id: &str) {
    if let Ok(mut state) = state.lock() {
        state.running.retain(|job| job.id != id);
        state.cancelled += 1;
    }
}

fn lane_count(items: &[DaemonJobState], lane: DaemonLane) -> usize {
    items.iter().filter(|job| job.lane == lane).count()
}

pub fn has_earlier_write_jobs(state: &SharedDaemonState, sequence: u64) -> bool {
    match state.lock() {
        Ok(state) => state.queued.iter().chain(state.running.iter()).any(|job| {
            job.lane == DaemonLane::Write && job.sequence < sequence
        }),
        Err(_) => false,
    }
}

pub fn record_metadata_barrier_wait(state: &SharedDaemonState, timed_out: bool) {
    if let Ok(mut state) = state.lock() {
        state.metadata_barrier_waits = state.metadata_barrier_waits.saturating_add(1);
        if timed_out {
            state.metadata_barrier_timeouts = state.metadata_barrier_timeouts.saturating_add(1);
        }
    }
}

fn write_lane_count(items: &[DaemonJobState]) -> usize {
    items.iter().filter(|job| job.lane == DaemonLane::Write).count()
}

pub fn snapshot(state: &SharedDaemonState) -> Value {
    match state.lock() {
        Ok(state) => {
            let lanes = all_daemon_lanes()
                .into_iter()
                .map(|lane| json!({
                    "lane": lane.as_str(),
                    "queued": lane_count(&state.queued, lane),
                    "running": lane_count(&state.running, lane)
                }))
                .collect::<Vec<Value>>();
            json!({
                "type": "daemon_status",
                "ok": true,
                "queued": state.queued.len(),
                "running": state.running.iter().map(|job| json!({ "id": &job.id, "command": &job.command, "lane": job.lane.as_str(), "sequence": job.sequence })).collect::<Vec<Value>>(),
                "queuedJobs": state.queued.iter().map(|job| json!({ "id": &job.id, "command": &job.command, "lane": job.lane.as_str(), "sequence": job.sequence })).collect::<Vec<Value>>(),
                "lanes": lanes,
                "completed": state.completed,
                "cancelled": state.cancelled,
                "failed": state.failed,
                "rejected": state.rejected,
                "nextSequence": state.next_sequence,
                "writeBarrier": {
                    "queuedWrites": write_lane_count(&state.queued),
                    "runningWrites": write_lane_count(&state.running),
                    "metadataBarrierWaits": state.metadata_barrier_waits,
                    "metadataBarrierTimeouts": state.metadata_barrier_timeouts
                },
                "workerMode": "rust-core-daemon-lane-runtime"
            })
        }
        Err(_) => json!({
            "type": "daemon_status",
            "ok": false,
            "message": "daemon state lock failed",
            "workerMode": "rust-core-daemon-lane-runtime"
        }),
    }
}

pub fn take_cancelled(cancelled: &CancelSet, id: &str) -> bool {
    match cancelled.lock() {
        Ok(mut set) => set.remove(id),
        Err(_) => false,
    }
}
