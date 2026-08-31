import type { RustCoreWorkerStatus } from './rustCoreWorkerRuntime'

export const EXPECTED_RUST_CORE_WORKER_VERSION = '0.42.0'
export const EXPECTED_RUST_CORE_PROTOCOL_VERSION = 42

export const REQUIRED_RUST_CORE_CAPABILITIES = [
  'handshake',
  'core-scheduler-profile',
  'rust-core-scheduler-policy',
  'rust-core-scheduler-result-cache',
  'rust-core-scheduler-backpressure',
  'rust-core-scheduler-cancellation',
  'rust-core-scheduler-interactive-lease',
  'rust-core-scheduler-adaptive-backoff',
  'rust-core-scheduler-queue-budget',
  'list-font-files',
  'directory-signatures',
  'font-signature-probe',
  'font-quick-fingerprint',
  'font-name-table-probe',
  'font-script-table-probe',
  'font-style-table-probe',
  'font-family-hint-probe',
  'font-aggregate-metadata-probe',
  'font-single-pass-metadata-probe',
  'font-parse-batch',
  'install-status-compare',
  'local-tags-read',
  'shared-metadata-known-tags',
  'shared-metadata-overlay-read',
  'rust-merged-index-protocol-result',
  'rust-query-tag-revision-metadata',
  'preview-cache-batch',
  'preview-cache-maintenance',
  'physical-folder-tree',
  'font-activation-files',
] as const

export type RustCoreCompatibilityResult = {
  ok: boolean
  message: string
}

export function rustCoreWorkerIsCompatible(status: RustCoreWorkerStatus): RustCoreCompatibilityResult {
  const protocol = Number(status.protocolVersion || 0)
  if (protocol < EXPECTED_RUST_CORE_PROTOCOL_VERSION) {
    return {
      ok: false,
      message: `stale protocol=${protocol}, expected>=${EXPECTED_RUST_CORE_PROTOCOL_VERSION}, expectedVersion=${EXPECTED_RUST_CORE_WORKER_VERSION}`,
    }
  }

  const capabilities = new Set(status.capabilities || [])
  const missing = REQUIRED_RUST_CORE_CAPABILITIES.filter((capability) => !capabilities.has(capability))
  if (missing.length) {
    return {
      ok: false,
      message: `missing capabilities=${missing.join(',')}, expectedVersion=${EXPECTED_RUST_CORE_WORKER_VERSION}`,
    }
  }

  return { ok: true, message: 'compatible' }
}
