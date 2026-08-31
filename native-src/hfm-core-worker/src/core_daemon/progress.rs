use serde_json::{json, Value};

use super::events::{emit_event, SharedStdout};
use super::types::DaemonLane;

pub fn emit_progress(stdout: &SharedStdout, id: &str, command: &str, lane: DaemonLane, stage: &str, progress: u8, elapsed_ms: Option<u64>) {
    emit_event(
        stdout,
        json!({
            "id": id,
            "type": "daemon_progress",
            "ok": true,
            "command": command,
            "lane": lane.as_str(),
            "stage": stage,
            "progress": progress,
            "elapsedMs": elapsed_ms
        }),
    );
}

pub fn emit_domain_events(stdout: &SharedStdout, id: &str, command: &str, lane: DaemonLane, stdout_json: &str) {
    let parsed = serde_json::from_str::<Value>(stdout_json).ok();
    if let Some(signal) = parsed.as_ref().and_then(|value| value.get("stateSignal")).filter(|value| value.is_object()) {
        let mutation_protocol = parsed.as_ref().and_then(|value| value.get("mutationProtocol")).cloned().unwrap_or(Value::Null);
        let (state_domain, state_event) = match command {
            "--local-tags-set" | "--local-tags-delete-tag" => ("localTags", "local_tags_changed"),
            "--shared-metadata-apply" | "--shared-metadata-remove-tag" => ("sharedMetadata", "shared_metadata_changed"),
            _ => ("state", "state_signal"),
        };
        emit_event(
            stdout,
            json!({
                "id": id,
                "type": "domain_event",
                "ok": true,
                "domain": state_domain,
                "event": state_event,
                "command": command,
                "lane": lane.as_str(),
                "stateSignal": signal,
                "mutationProtocol": mutation_protocol
            }),
        );
    }

    let index_protocol = parsed.as_ref().and_then(|value| value.get("indexProtocol")).cloned().unwrap_or(Value::Null);

    let (domain, event) = match command {
        "--root-index-apply-changes" | "--merged-index-rebuild" | "--merged-index-sync" => ("index", "index_changed"),
        "--list-font-files" => ("scan", "scan_listed"),
        "--font-parse-batch" => ("scan", "scan_parsed"),
        "--watcher-batch-preflight" => ("watcher", "watcher_preflight_checked"),
        "--preview-cache-apply" | "--preview-cache-delete" | "--preview-cache-maintenance" => ("previewCache", "preview_cache_changed"),
        "--install-status-save" => ("installStatus", "install_status_changed"),
        "--font-resource-add" | "--font-resource-remove" | "--font-registry-apply" | "--font-registry-delete" | "--font-activation-files" => ("activation", "font_activation_changed"),
        _ => return,
    };

    emit_event(
        stdout,
        json!({
            "id": id,
            "type": "domain_event",
            "ok": true,
            "domain": domain,
            "event": event,
            "command": command,
            "lane": lane.as_str(),
            "indexProtocol": index_protocol
        }),
    );
}
