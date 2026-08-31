export const RUST_CORE_DAEMON_READ_SAFE_COMMANDS = [
  '--core-scheduler-profile',
  '--merged-index-query-page',
  '--merged-index-query-metrics',
  '--merged-index-query-ids',
  '--install-status-read',
  '--install-status-compare',
  '--preview-cache-read-status',
  '--preview-cache-query',
  '--preview-cache-touch',
  '--preview-cache-batch',
  '--preview-cache-apply',
  '--preview-cache-delete',
  '--preview-cache-maintenance',
  '--shared-metadata-signature',
  '--shared-metadata-known-tags',
  '--shared-metadata-overlay-read',
  '--local-tags-read',
  '--watcher-batch-preflight',
  '--system-installed-fonts',
  '--database-health-check',
  '--physical-folder-tree',
] as const

export const RUST_CORE_DAEMON_LONG_RUNNING_SCAN_COMMANDS = [
  '--list-font-files',
  '--font-parse-batch',
] as const

export const RUST_CORE_DAEMON_REPLACEABLE_PREVIEW_COMMANDS = [
  '--preview-render-image',
] as const

export const RUST_CORE_DAEMON_SERIAL_MUTATION_COMMANDS = [
  '--local-tags-set',
  '--local-tags-delete-tag',
  '--shared-metadata-apply',
  '--shared-metadata-remove-tag',
  '--root-index-apply-changes',
  '--merged-index-rebuild',
  '--merged-index-sync',
  '--install-status-save',
  '--database-backup',
  '--font-resource-add',
  '--font-resource-remove',
  '--font-resource-notify',
  '--font-registry-apply',
  '--font-registry-delete',
  '--font-activation-files',
] as const

export const RUST_CORE_DAEMON_NO_FALLBACK_AFTER_SUBMIT_COMMANDS = [
  ...RUST_CORE_DAEMON_LONG_RUNNING_SCAN_COMMANDS,
  ...RUST_CORE_DAEMON_REPLACEABLE_PREVIEW_COMMANDS,
  ...RUST_CORE_DAEMON_SERIAL_MUTATION_COMMANDS,
] as const

export const RUST_CORE_DAEMON_SAFE_COMMANDS = [
  ...RUST_CORE_DAEMON_READ_SAFE_COMMANDS,
  ...RUST_CORE_DAEMON_LONG_RUNNING_SCAN_COMMANDS,
  ...RUST_CORE_DAEMON_REPLACEABLE_PREVIEW_COMMANDS,
  ...RUST_CORE_DAEMON_SERIAL_MUTATION_COMMANDS,
] as const

const NO_FALLBACK_AFTER_SUBMIT = new Set<string>(RUST_CORE_DAEMON_NO_FALLBACK_AFTER_SUBMIT_COMMANDS)

export function rustCoreDaemonBlocksOneShotFallbackAfterSubmit(command: string): boolean {
  return NO_FALLBACK_AFTER_SUBMIT.has(command)
}

export const RUST_CORE_DAEMON_SAFE_COMMAND_SUMMARY = [
  'scheduler-profile',
  'merged-index-read-queries',
  'scan-listing-parse-pipeline',
  'install-status-read-compare-save',
  'preview-cache-read-query-touch-batch-apply-delete-maintenance',
  'preview-render-image',
  'shared-metadata-signature-known-tags-overlay-local-tags-read',
  'local-tags-serial-mutations',
  'shared-metadata-serial-mutations',
  'root-merged-index-serial-writes',
  'watcher-preflight',
  'system-installed-fonts',
  'database-health-check-backup',
  'font-resource-add-remove-notify',
  'font-registry-apply-delete',
  'font-activation-files',
  'physical-folder-tree',
  'daemon-priority-lanes-progress-domain-events',
  'daemon-sequenced-write-lane-metadata-read-barrier',
].join(',')
