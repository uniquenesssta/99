use std::env;

use crate::json::escape_json;

pub const WORKER_NAME: &str = "hfm-core-worker";
pub const WORKER_VERSION: &str = "0.42.0";
pub const PROTOCOL_VERSION: u32 = 42;

pub fn print_handshake() {
    println!(
        "{{\"ok\":true,\"name\":\"{}\",\"version\":\"{}\",\"protocolVersion\":{},\"platform\":\"{}\",\"arch\":\"{}\",\"capabilities\":[\"handshake\",\"core-scheduler-profile\",\"rust-core-scheduler-policy\",\"rust-core-scheduler-result-cache\",\"rust-core-scheduler-backpressure\",\"rust-core-scheduler-cancellation\",\"rust-core-scheduler-interactive-lease\",\"rust-core-scheduler-adaptive-backoff\",\"rust-core-scheduler-queue-budget\",\"core-daemon-job-runtime\",\"rust-core-daemon-job-submit\",\"rust-core-daemon-event-stream\",\"rust-core-daemon-priority-lanes\",\"rust-core-daemon-progress-stream\",\"rust-core-daemon-domain-events\",\"rust-core-daemon-job-cancel-protocol\",\"rust-core-daemon-sequenced-write-lane\",\"rust-core-daemon-metadata-read-barrier\",\"list-font-files\",\"directory-signatures\",\"font-signature-probe\",\"font-quick-fingerprint\",\"font-name-table-probe\",\"font-content-fingerprint\",\"font-full-fingerprint\",\"font-script-table-probe\",\"font-rust-metadata-fast-path\",\"font-style-table-probe\",\"font-style-fast-path\",\"font-family-hint-probe\",\"font-family-fast-path\",\"font-aggregate-metadata-probe\",\"font-single-pass-metadata-probe\",\"font-single-open-file-probe\",\"font-single-open-fingerprint\",\"font-parse-batch\",\"rust-font-parse-batch-fast-path\",\"root-index-sqlite-apply-changes\",\"merged-index-page-query\",\"rust-query-page-fast-path\",\"merged-index-metrics-query\",\"rust-metrics-fast-path\",\"merged-index-rebuild\",\"rust-merged-index-rebuild-fast-path\",\"merged-index-sync\",\"rust-merged-index-sync-fast-path\",\"rust-merged-index-protocol-result\",\"rust-query-tag-revision-metadata\",\"merged-index-ids-query\",\"rust-query-ids-fast-path\",\"merged-index-category-index\",\"rust-category-filter-fast-path\",\"merged-index-search-text\",\"rust-search-text-fast-path\",\"system-installed-fonts\",\"rust-system-installed-fonts-fast-path\",\"watcher-batch-preflight\",\"rust-watcher-preflight-fast-path\",\"manual-refresh-listing\",\"rust-manual-refresh-fast-path\",\"physical-folder-tree\",\"rust-physical-folder-tree-fast-path\",\"install-status-index-read\",\"install-status-index-save\",\"install-status-compare\",\"rust-install-status-compare-fast-path\",\"rust-install-status-db-fast-path\",\"local-tags-set\",\"local-tags-read\",\"local-tags-delete-tag\",\"rust-local-tags-state-machine\",\"rust-local-tags-read-authority\",\"rust-local-tags-db-fast-path\",\"rust-tag-mutation-protocol-result\",\"shared-metadata-apply\",\"shared-metadata-remove-tag\",\"shared-metadata-known-tags\",\"shared-metadata-overlay-read\",\"shared-metadata-signature\",\"rust-shared-metadata-state-machine\",\"rust-shared-metadata-known-tags-authority\",\"rust-shared-metadata-overlay-read-authority\",\"rust-shared-metadata-daemon-serial-mutations\",\"rust-shared-metadata-db-fast-path\",\"preview-cache-index-read\",\"preview-cache-index-apply\",\"preview-cache-index-delete\",\"preview-cache-index-query\",\"preview-cache-index-touch\",\"preview-cache-batch\",\"preview-cache-maintenance\",\"rust-preview-cache-db-fast-path\",\"font-resource-add\",\"font-resource-remove\",\"font-resource-notify\",\"font-activation-files\",\"font-registry-apply\",\"font-registry-delete\",\"rust-font-activation-resource-fast-path\",\"preview-render-image\",\"rust-preview-render-fast-path\",\"rust-directwrite-preview-fast-path\",\"database-health-check\",\"database-backup\",\"rust-database-maintenance-fast-path\"]}}",
        WORKER_NAME,
        WORKER_VERSION,
        PROTOCOL_VERSION,
        env::consts::OS,
        env::consts::ARCH
    );
}

pub fn print_error(message: &str) {
    println!(
        "{{\"ok\":false,\"message\":\"{}\"}}",
        escape_json(message)
    );
}
