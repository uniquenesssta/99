import { rustFullMigrationEnabled } from './rustFullMigrationPolicyRuntime'

export type NodeStateFallbackSource =
  | 'local-tags-read'
  | 'local-tags-write'
  | 'local-tags-delete'
  | 'shared-metadata-apply'
  | 'shared-metadata-remove-tag'
  | 'install-status-read'
  | 'install-status-write'
  | string

export type NodeStateFallbackMode = 'disabled' | 'explicit-compatibility' | 'legacy-node'

export type NodeStateFallbackPolicySnapshot = {
  mode: NodeStateFallbackMode
  rustFullMigration: boolean
  nodeStateFallback: boolean
  requiredEnv: 'HFM_NODE_STATE_FALLBACK=1'
  writesRequireExplicitCompatibility: boolean
  readsRequireExplicitCompatibility: boolean
}

function explicitNodeStateFallbackEnabled(): boolean {
  const mode = String(process.env.HFM_NODE_STATE_FALLBACK || '').trim().toLowerCase()
  return mode === '1' || mode === 'true' || mode === 'on'
}

export function nodeStateFallbackPolicySnapshot(): NodeStateFallbackPolicySnapshot {
  const rustFullMigration = rustFullMigrationEnabled()
  const nodeStateFallback = explicitNodeStateFallbackEnabled()
  return {
    mode: !rustFullMigration ? 'legacy-node' : nodeStateFallback ? 'explicit-compatibility' : 'disabled',
    rustFullMigration,
    nodeStateFallback,
    requiredEnv: 'HFM_NODE_STATE_FALLBACK=1',
    writesRequireExplicitCompatibility: true,
    readsRequireExplicitCompatibility: true,
  }
}

export function nodeStateFallbackCompatibilityAllowed(): boolean {
  return nodeStateFallbackPolicySnapshot().mode !== 'disabled'
}

export function nodeStateFallbackPolicyReason(): string {
  const policy = nodeStateFallbackPolicySnapshot()
  if (policy.mode === 'legacy-node') return 'rust-full-migration-off'
  if (policy.mode === 'explicit-compatibility') return 'explicit-node-state-fallback'
  return 'rust-full-migration'
}

export function nodeStateFallbackPolicyLogLine(): string {
  const policy = nodeStateFallbackPolicySnapshot()
  return `nodeStateFallback=${policy.mode}, requiredEnv=${policy.requiredEnv}`
}

export function nodeStateFallbackDeniedMessage(source: NodeStateFallbackSource): string {
  return `rust full migration: ${source} fallback disabled; enable HFM_NODE_STATE_FALLBACK=1 for explicit compatibility mode`
}

export function logNodeStateFallbackDisabled(options: {
  appendStartupLog?: (message: string) => void
  source: NodeStateFallbackSource
  reason?: string
}): void {
  options.appendStartupLog?.(`${nodeStateFallbackDeniedMessage(options.source)}, reason=${options.reason || nodeStateFallbackPolicyReason()}`)
}

export function logNodeStateFallbackUsed(options: {
  appendStartupLog?: (message: string) => void
  source: NodeStateFallbackSource
  reason?: string
  detail?: string
}): void {
  const detail = options.detail ? `, ${options.detail}` : ''
  options.appendStartupLog?.(`node state fallback used: source=${options.source}, reason=${options.reason || nodeStateFallbackPolicyReason()}${detail}`)
}
