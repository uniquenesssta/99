mod dispatcher;
mod events;
mod lanes;
mod maintenance_commands;
mod preview_commands;
mod progress;
mod resource_commands;
mod scan_commands;
mod state;
mod types;
mod write_barrier;

use std::io::{self, BufRead};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Instant;

use serde_json::json;

use self::dispatcher::run_daemon_command;
use self::events::{emit_event, error_json, SharedStdout};
use self::lanes::DaemonLaneSenders;
use self::progress::{emit_domain_events, emit_progress};
use self::state::{cancel_after_start, cancel_before_start, enqueue, finish, new_cancel_set, new_shared_state, queued_len_for_lane, reject_enqueue, snapshot, start, take_cancelled, CancelSet, SharedDaemonState};
use self::types::{command_from_args, lane_for_command, max_queued_for_lane, DaemonJob, DaemonLane, DaemonRequest};
use self::write_barrier::wait_for_metadata_write_barrier;

pub fn run_core_daemon_stdio() -> i32 {
    let stdout = Arc::new(std::sync::Mutex::new(io::stdout()));
    let cancelled: CancelSet = new_cancel_set();
    let daemon_state: SharedDaemonState = new_shared_state();

    let (foreground_sender, foreground_receiver) = mpsc::channel::<DaemonJob>();
    let (preview_sender, preview_receiver) = mpsc::channel::<DaemonJob>();
    let (scan_sender, scan_receiver) = mpsc::channel::<DaemonJob>();
    let (write_sender, write_receiver) = mpsc::channel::<DaemonJob>();
    let (maintenance_sender, maintenance_receiver) = mpsc::channel::<DaemonJob>();
    let (activation_sender, activation_receiver) = mpsc::channel::<DaemonJob>();
    let (background_sender, background_receiver) = mpsc::channel::<DaemonJob>();

    let senders = DaemonLaneSenders {
        foreground: foreground_sender,
        preview: preview_sender,
        scan: scan_sender,
        write: write_sender,
        maintenance: maintenance_sender,
        activation: activation_sender,
        background: background_sender,
    };

    emit_event(
        &stdout,
        json!({
            "type": "daemon_ready",
            "ok": true,
            "workerMode": "rust-core-daemon-lane-runtime",
            "lanes": ["foreground", "preview", "scan", "write", "maintenance", "activation", "background"]
        }),
    );

    let workers = vec![
        spawn_lane_worker(DaemonLane::Foreground, foreground_receiver, Arc::clone(&stdout), Arc::clone(&cancelled), Arc::clone(&daemon_state)),
        spawn_lane_worker(DaemonLane::Preview, preview_receiver, Arc::clone(&stdout), Arc::clone(&cancelled), Arc::clone(&daemon_state)),
        spawn_lane_worker(DaemonLane::Scan, scan_receiver, Arc::clone(&stdout), Arc::clone(&cancelled), Arc::clone(&daemon_state)),
        spawn_lane_worker(DaemonLane::Write, write_receiver, Arc::clone(&stdout), Arc::clone(&cancelled), Arc::clone(&daemon_state)),
        spawn_lane_worker(DaemonLane::Maintenance, maintenance_receiver, Arc::clone(&stdout), Arc::clone(&cancelled), Arc::clone(&daemon_state)),
        spawn_lane_worker(DaemonLane::Activation, activation_receiver, Arc::clone(&stdout), Arc::clone(&cancelled), Arc::clone(&daemon_state)),
        spawn_lane_worker(DaemonLane::Background, background_receiver, Arc::clone(&stdout), Arc::clone(&cancelled), Arc::clone(&daemon_state)),
    ];

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let request = match serde_json::from_str::<DaemonRequest>(trimmed) {
            Ok(request) => request,
            Err(error) => {
                emit_event(
                    &stdout,
                    json!({
                        "type": "protocol_error",
                        "ok": false,
                        "message": error.to_string()
                    }),
                );
                continue;
            }
        };

        let request_type = request
            .request_type
            .clone()
            .unwrap_or_else(|| "submit".to_string());
        if request_type == "shutdown" {
            emit_event(&stdout, json!({ "type": "daemon_shutdown", "ok": true }));
            break;
        }
        if request_type == "status" {
            emit_event(&stdout, snapshot(&daemon_state));
            continue;
        }

        let id = request.id.unwrap_or_default();
        if id.is_empty() {
            emit_event(
                &stdout,
                json!({
                    "type": "protocol_error",
                    "ok": false,
                    "message": "missing job id"
                }),
            );
            continue;
        }

        if request_type == "cancel" {
            if let Ok(mut set) = cancelled.lock() {
                set.insert(id.clone());
            }
            emit_event(
                &stdout,
                json!({
                    "id": id,
                    "type": "job_cancel_requested",
                    "ok": true
                }),
            );
            continue;
        }

        if request_type != "submit" {
            emit_event(
                &stdout,
                json!({
                    "id": id,
                    "type": "job_failed",
                    "ok": false,
                    "message": format!("unsupported daemon request type: {}", request_type)
                }),
            );
            continue;
        }

        let args = request.args.unwrap_or_default();
        if args.is_empty() {
            emit_event(
                &stdout,
                json!({
                    "id": id,
                    "type": "job_failed",
                    "ok": false,
                    "stdout": error_json("missing job args"),
                    "elapsedMs": 0
                }),
            );
            continue;
        }

        let command = command_from_args(&args);
        let lane = lane_for_command(&command);
        let max_queued = max_queued_for_lane(lane);
        if queued_len_for_lane(&daemon_state, lane) >= max_queued {
            reject_enqueue(&daemon_state);
            emit_event(
                &stdout,
                json!({
                    "id": id,
                    "type": "job_failed",
                    "ok": false,
                    "command": command,
                    "lane": lane.as_str(),
                    "stdout": error_json(&format!("daemon lane queue full: lane={}, maxQueued={}", lane.as_str(), max_queued)),
                    "elapsedMs": 0
                }),
            );
            continue;
        }

        let sequence = enqueue(&daemon_state, &id, &command, lane);
        emit_event(
            &stdout,
            json!({
                "id": id.clone(),
                "type": "job_queued",
                "ok": true,
                "command": command,
                "lane": lane.as_str(),
                "sequence": sequence
            }),
        );
        emit_progress(&stdout, &id, &command, lane, "queued", 0, None);

        if senders.send(DaemonJob { id, args, command, lane, sequence }).is_err() {
            emit_event(
                &stdout,
                json!({
                    "type": "job_failed",
                    "ok": false,
                    "message": "daemon worker queue closed"
                }),
            );
            break;
        }
    }

    drop(senders);
    for worker in workers {
        let _ = worker.join();
    }
    0
}

fn spawn_lane_worker(lane: DaemonLane, receiver: mpsc::Receiver<DaemonJob>, stdout: SharedStdout, cancelled: CancelSet, daemon_state: SharedDaemonState) -> thread::JoinHandle<()> {
    thread::spawn(move || run_worker_loop(lane, receiver, stdout, cancelled, daemon_state))
}

fn run_worker_loop(lane: DaemonLane, receiver: mpsc::Receiver<DaemonJob>, stdout: SharedStdout, cancelled: CancelSet, daemon_state: SharedDaemonState) {
    while let Ok(job) = receiver.recv() {
        let id = job.id;
        let args = job.args;
        let command = job.command;
        let job_lane = job.lane;
        let sequence = job.sequence;

        if take_cancelled(&cancelled, &id) {
            cancel_before_start(&daemon_state, &id);
            emit_event(
                &stdout,
                json!({
                    "id": id,
                    "type": "job_cancelled",
                    "ok": false,
                    "command": command,
                    "lane": job_lane.as_str(),
                    "elapsedMs": 0
                }),
            );
            continue;
        }

        let barrier_wait_ms = wait_for_metadata_write_barrier(&daemon_state, &stdout, &id, &command, job_lane, sequence);
        start(&daemon_state, &id, &command, job_lane, sequence);
        emit_event(
            &stdout,
            json!({
                "id": id.clone(),
                "type": "job_started",
                "ok": true,
                "command": command.clone(),
                "lane": job_lane.as_str(),
                "sequence": sequence,
                "metadataBarrierWaitMs": barrier_wait_ms
            }),
        );
        emit_progress(&stdout, &id, &command, job_lane, "started", 5, None);

        let started = Instant::now();
        let command_result = run_daemon_command(&args);
        let stdout_json = match command_result {
            Ok(json) => json,
            Err(message) => error_json(&message),
        };
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let ok = !stdout_json.contains("\"ok\":false");
        let cancelled_after_run = take_cancelled(&cancelled, &id);
        if cancelled_after_run {
            cancel_after_start(&daemon_state, &id);
            emit_progress(&stdout, &id, &command, job_lane, "cancelled", 100, Some(elapsed_ms));
            emit_event(
                &stdout,
                json!({
                    "id": id,
                    "type": "job_cancelled",
                    "ok": false,
                    "command": command,
                    "lane": lane.as_str(),
                    "elapsedMs": elapsed_ms,
                    "sequence": sequence
                }),
            );
            continue;
        }

        finish(&daemon_state, &id, ok);
        emit_progress(&stdout, &id, &command, job_lane, if ok { "finished" } else { "failed" }, 100, Some(elapsed_ms));
        if ok {
            emit_domain_events(&stdout, &id, &command, job_lane, &stdout_json);
        }

        emit_event(
            &stdout,
            json!({
                "id": id,
                "type": "job_finished",
                "ok": ok,
                "command": command,
                "lane": job_lane.as_str(),
                "stdout": stdout_json,
                "stderr": "",
                "elapsedMs": elapsed_ms,
                "sequence": sequence
            }),
        );
    }
}
