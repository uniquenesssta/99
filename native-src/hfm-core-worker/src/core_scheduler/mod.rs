use std::time::Instant;

use serde::Serialize;

#[derive(Clone, Debug)]
pub struct CoreSchedulerProfileConfig;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerProfile {
    command: &'static str,
    lane: &'static str,
    priority: u32,
    max_concurrency: u32,
    coalesce_ms: u32,
    cache_ms: u32,
    interactive: bool,
    background_throttle: bool,
    generation_scope: &'static str,
    cancel_queued_on_newer: bool,
    abort_running_on_newer: bool,
    discard_stale_results: bool,
    slow_ms: u32,
    cooldown_ms: u32,
    adaptive_throttle: bool,
    nas_sensitive: bool,
    max_queued: u32,
    queued_ttl_ms: u32,
    drop_queued_on_overflow: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerQueuePolicy {
    global_max_concurrency: u32,
    interactive_reserve: u32,
    block_background_when_interactive_queued: bool,
    block_maintenance_when_interactive_active: bool,
    scheduler_yield_ms: u32,
    interactive_quiet_ms: u32,
    adaptive_backoff_max_ms: u32,
    queued_task_prune_ms: u32,
    metadata_read_barrier: bool,
    metadata_read_barrier_timeout_ms: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SchedulerProfileResult {
    ok: bool,
    scheduler_version: &'static str,
    profiles: Vec<SchedulerProfile>,
    queue_policy: SchedulerQueuePolicy,
    elapsed_ms: u128,
    worker_mode: &'static str,
}

pub fn read_core_scheduler_profile(_: &CoreSchedulerProfileConfig) -> Result<String, String> {
    let started_at = Instant::now();
    let profiles = vec![
        profile("--core-scheduler-profile", "foreground", 110, 1, 1000, 5000, true, false),
        replaceable_profile("--merged-index-query-page", "foreground", 100, 2, 40, 180, true, false, "page-query", true),
        replaceable_profile("--merged-index-query-metrics", "foreground", 96, 1, 120, 900, true, false, "metrics", true),
        replaceable_profile("--merged-index-query-ids", "foreground", 94, 1, 80, 300, true, false, "ids-query", true),
        profile("--preview-cache-batch", "preview", 86, 1, 80, 500, true, false),
        profile("--preview-cache-query", "preview", 82, 1, 80, 500, true, false),
        profile("--preview-cache-read-status", "preview", 80, 1, 60, 300, true, false),
        profile("--preview-cache-apply", "preview", 66, 1, 0, 0, false, false),
        profile("--preview-cache-delete", "preview", 68, 1, 0, 0, false, false),
        profile("--preview-cache-touch", "preview", 45, 1, 200, 0, false, true),
        profile("--preview-render-image", "preview", 84, 1, 20, 0, true, false),
        profile("--list-font-files", "scan", 28, 1, 0, 0, false, true),
        profile("--font-parse-batch", "scan", 30, 1, 0, 0, false, true),
        profile("--root-index-apply-changes", "write", 60, 1, 0, 0, false, false),
        profile("--merged-index-sync", "write", 58, 1, 80, 0, false, false),
        profile("--merged-index-rebuild", "write", 46, 1, 0, 0, false, true),
        replaceable_profile("--shared-metadata-signature", "foreground", 58, 1, 200, 1000, true, false, "shared-metadata-signature", true),
        replaceable_profile("--shared-metadata-known-tags", "foreground", 59, 1, 200, 1000, true, false, "shared-metadata-known-tags", true),
        replaceable_profile("--shared-metadata-overlay-read", "foreground", 61, 1, 80, 500, true, false, "shared-metadata-overlay-read", true),
        replaceable_profile("--local-tags-read", "foreground", 60, 1, 80, 500, true, false, "local-tags-read", true),
        profile("--local-tags-set", "write", 74, 1, 0, 0, true, false),
        profile("--local-tags-delete-tag", "write", 74, 1, 0, 0, true, false),
        profile("--shared-metadata-apply", "write", 72, 1, 0, 0, true, false),
        profile("--shared-metadata-remove-tag", "write", 72, 1, 0, 0, true, false),
        profile("--install-status-read", "io", 54, 1, 120, 600, false, false),
        profile("--install-status-save", "write", 50, 1, 0, 0, false, false),
        profile("--install-status-compare", "background", 34, 1, 0, 0, false, true),
        replaceable_profile("--watcher-batch-preflight", "background", 38, 1, 100, 500, false, true, "watcher-preflight", true),
        replaceable_profile("--physical-folder-tree", "background", 36, 1, 300, 1000, true, false, "folder-tree", true),
        profile("--system-installed-fonts", "background", 32, 1, 0, 0, false, true),
        profile("--preview-cache-maintenance", "maintenance", 12, 1, 500, 0, false, true),
        profile("--database-health-check", "maintenance", 14, 1, 500, 0, false, true),
        profile("--database-backup", "maintenance", 10, 1, 0, 0, false, true),
        profile("--font-resource-add", "activation", 78, 1, 0, 0, true, false),
        profile("--font-resource-remove", "activation", 78, 1, 0, 0, true, false),
        profile("--font-resource-notify", "activation", 74, 1, 80, 0, true, false),
        profile("--font-registry-apply", "activation", 76, 1, 0, 0, true, false),
        profile("--font-registry-delete", "activation", 76, 1, 0, 0, true, false),
        profile("--font-activation-files", "activation", 72, 1, 0, 0, true, false),
    ];
    let result = SchedulerProfileResult {
        ok: true,
        scheduler_version: "1.0.0",
        profiles,
        queue_policy: SchedulerQueuePolicy {
            global_max_concurrency: 3,
            interactive_reserve: 1,
            block_background_when_interactive_queued: true,
            block_maintenance_when_interactive_active: true,
            scheduler_yield_ms: 16,
            interactive_quiet_ms: 220,
            adaptive_backoff_max_ms: 3000,
            queued_task_prune_ms: 1000,
            metadata_read_barrier: true,
            metadata_read_barrier_timeout_ms: 5000,
        },
        elapsed_ms: started_at.elapsed().as_millis(),
        worker_mode: "rust-core-scheduler-queue-budget-profile",
    };
    serde_json::to_string(&result).map_err(|error| error.to_string())
}

fn profile(command: &'static str, lane: &'static str, priority: u32, max_concurrency: u32, coalesce_ms: u32, cache_ms: u32, interactive: bool, background_throttle: bool) -> SchedulerProfile {
    SchedulerProfile {
        command,
        lane,
        priority,
        max_concurrency,
        coalesce_ms,
        cache_ms,
        interactive,
        background_throttle,
        generation_scope: "",
        cancel_queued_on_newer: false,
        abort_running_on_newer: false,
        discard_stale_results: false,
        slow_ms: default_slow_ms(lane),
        cooldown_ms: default_cooldown_ms(lane),
        adaptive_throttle: default_adaptive_throttle(lane),
        nas_sensitive: default_nas_sensitive(lane),
        max_queued: default_max_queued(lane),
        queued_ttl_ms: default_queued_ttl_ms(lane),
        drop_queued_on_overflow: default_drop_queued_on_overflow(lane, false),
    }
}

fn replaceable_profile(
    command: &'static str,
    lane: &'static str,
    priority: u32,
    max_concurrency: u32,
    coalesce_ms: u32,
    cache_ms: u32,
    interactive: bool,
    background_throttle: bool,
    generation_scope: &'static str,
    abort_running_on_newer: bool,
) -> SchedulerProfile {
    SchedulerProfile {
        command,
        lane,
        priority,
        max_concurrency,
        coalesce_ms,
        cache_ms,
        interactive,
        background_throttle,
        generation_scope,
        cancel_queued_on_newer: true,
        abort_running_on_newer,
        discard_stale_results: true,
        slow_ms: default_slow_ms(lane),
        cooldown_ms: default_cooldown_ms(lane),
        adaptive_throttle: default_adaptive_throttle(lane),
        nas_sensitive: default_nas_sensitive(lane),
        max_queued: default_max_queued(lane),
        queued_ttl_ms: default_queued_ttl_ms(lane),
        drop_queued_on_overflow: default_drop_queued_on_overflow(lane, true),
    }
}


fn default_slow_ms(lane: &str) -> u32 {
    match lane {
        "foreground" | "preview" | "activation" => 1200,
        "io" | "write" => 2500,
        _ => 4000,
    }
}

fn default_cooldown_ms(lane: &str) -> u32 {
    match lane {
        "scan" | "maintenance" | "background" => 1200,
        "io" | "write" | "preview" => 700,
        _ => 0,
    }
}

fn default_adaptive_throttle(lane: &str) -> bool {
    matches!(lane, "scan" | "maintenance" | "background" | "io" | "write")
}

fn default_nas_sensitive(lane: &str) -> bool {
    matches!(lane, "scan" | "preview" | "io" | "write" | "maintenance")
}


fn default_max_queued(lane: &str) -> u32 {
    match lane {
        "foreground" => 8,
        "preview" => 24,
        "io" | "write" => 10,
        "activation" => 12,
        "scan" | "background" => 3,
        "maintenance" => 1,
        _ => 4,
    }
}

fn default_queued_ttl_ms(lane: &str) -> u32 {
    match lane {
        "foreground" => 2_000,
        "preview" => 3_000,
        "io" | "write" => 8_000,
        "activation" => 20_000,
        "scan" | "background" => 10_000,
        "maintenance" => 30_000,
        _ => 5_000,
    }
}

fn default_drop_queued_on_overflow(lane: &str, replaceable: bool) -> bool {
    replaceable || matches!(lane, "scan" | "background" | "maintenance")
}
