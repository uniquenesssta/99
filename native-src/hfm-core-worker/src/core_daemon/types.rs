use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DaemonRequest {
    pub id: Option<String>,
    #[serde(rename = "type")]
    pub request_type: Option<String>,
    pub args: Option<Vec<String>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DaemonLane {
    Foreground,
    Preview,
    Scan,
    Write,
    Maintenance,
    Activation,
    Background,
}

impl DaemonLane {
    pub fn as_str(self) -> &'static str {
        match self {
            DaemonLane::Foreground => "foreground",
            DaemonLane::Preview => "preview",
            DaemonLane::Scan => "scan",
            DaemonLane::Write => "write",
            DaemonLane::Maintenance => "maintenance",
            DaemonLane::Activation => "activation",
            DaemonLane::Background => "background",
        }
    }
}

#[derive(Debug)]
pub struct DaemonJob {
    pub id: String,
    pub args: Vec<String>,
    pub command: String,
    pub lane: DaemonLane,
    pub sequence: u64,
}

pub fn all_daemon_lanes() -> Vec<DaemonLane> {
    vec![
        DaemonLane::Foreground,
        DaemonLane::Preview,
        DaemonLane::Scan,
        DaemonLane::Write,
        DaemonLane::Maintenance,
        DaemonLane::Activation,
        DaemonLane::Background,
    ]
}

pub fn command_from_args(args: &[String]) -> String {
    args.iter()
        .find(|arg| arg.starts_with("--"))
        .cloned()
        .unwrap_or_else(|| "*".to_string())
}

pub fn lane_for_command(command: &str) -> DaemonLane {
    match command {
        "--merged-index-query-page"
        | "--merged-index-query-metrics"
        | "--merged-index-query-ids"
        | "--install-status-read"
        | "--install-status-compare"
        | "--shared-metadata-signature"
        | "--shared-metadata-known-tags"
        | "--shared-metadata-overlay-read"
        | "--local-tags-read"
        | "--system-installed-fonts"
        | "--physical-folder-tree"
        | "--core-scheduler-profile" => DaemonLane::Foreground,
        "--preview-cache-read-status"
        | "--preview-cache-query"
        | "--preview-cache-touch"
        | "--preview-cache-batch"
        | "--preview-cache-apply"
        | "--preview-cache-delete"
        | "--preview-render-image" => DaemonLane::Preview,
        "--list-font-files"
        | "--font-parse-batch"
        | "--watcher-batch-preflight" => DaemonLane::Scan,
        "--local-tags-set"
        | "--local-tags-delete-tag"
        | "--shared-metadata-apply"
        | "--shared-metadata-remove-tag"
        | "--root-index-apply-changes"
        | "--merged-index-rebuild"
        | "--merged-index-sync"
        | "--install-status-save" => DaemonLane::Write,
        "--database-health-check"
        | "--database-backup"
        | "--preview-cache-maintenance" => DaemonLane::Maintenance,
        "--font-resource-add"
        | "--font-resource-remove"
        | "--font-resource-notify"
        | "--font-registry-apply"
        | "--font-registry-delete"
        | "--font-activation-files" => DaemonLane::Activation,
        _ => DaemonLane::Background,
    }
}

pub fn max_queued_for_lane(lane: DaemonLane) -> usize {
    match lane {
        DaemonLane::Foreground => 64,
        DaemonLane::Preview => 96,
        DaemonLane::Scan => 8,
        DaemonLane::Write => 24,
        DaemonLane::Maintenance => 4,
        DaemonLane::Activation => 16,
        DaemonLane::Background => 8,
    }
}
