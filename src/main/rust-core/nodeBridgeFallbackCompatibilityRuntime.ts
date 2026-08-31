import { rustFullMigrationEnabled } from './rustFullMigrationPolicyRuntime'

export type NodeBridgeFallbackSource =
  | 'preview-render-directwrite'
  | 'preview-render-powershell'
  | 'activation-copy'
  | 'activation-delete-inline'
  | 'activation-delete-async'
  | string

export type NodeBridgeFallbackMode = 'disabled' | 'explicit-compatibility' | 'legacy-node'

export type NodeBridgeFallbackPolicySnapshot = {
  mode: NodeBridgeFallbackMode
  rustFullMigration: boolean
  nodeBridgeFallback: boolean
  requiredEnv: 'HFM_NODE_BRIDGE_FALLBACK=1'
  previewRenderFallbackRequiresExplicitCompatibility: boolean
  activationFileFallbackRequiresExplicitCompatibility: boolean
}

const REQUIRED_ENV = 'HFM_NODE_BRIDGE_FALLBACK=1' as const

function explicitNodeBridgeFallbackEnabled(): boolean {
  const mode = String(process.env.HFM_NODE_BRIDGE_FALLBACK || '').trim().toLowerCase()
  return mode === '1' || mode === 'true' || mode === 'on'
}

export function nodeBridgeFallbackPolicySnapshot(): NodeBridgeFallbackPolicySnapshot {
  const rustFullMigration = rustFullMigrationEnabled()
  const nodeBridgeFallback = explicitNodeBridgeFallbackEnabled()
  return {
    mode: !rustFullMigration ? 'legacy-node' : nodeBridgeFallback ? 'explicit-compatibility' : 'disabled',
    rustFullMigration,
    nodeBridgeFallback,
    requiredEnv: REQUIRED_ENV,
    previewRenderFallbackRequiresExplicitCompatibility: true,
    activationFileFallbackRequiresExplicitCompatibility: true,
  }
}

export function nodeBridgeFallbackCompatibilityAllowed(): boolean {
  return nodeBridgeFallbackPolicySnapshot().mode !== 'disabled'
}

export function nodeBridgeFallbackPolicyReason(): string {
  const policy = nodeBridgeFallbackPolicySnapshot()
  if (policy.mode === 'legacy-node') return 'rust-full-migration-off'
  if (policy.mode === 'explicit-compatibility') return 'explicit-node-bridge-fallback'
  return 'rust-full-migration'
}

export function nodeBridgeFallbackPolicyLogLine(): string {
  const policy = nodeBridgeFallbackPolicySnapshot()
  return `nodeBridgeFallback=${policy.mode}, requiredEnv=${policy.requiredEnv}`
}

export function nodeBridgeFallbackDeniedMessage(source: NodeBridgeFallbackSource): string {
  return `rust full migration: ${source} fallback disabled; enable ${REQUIRED_ENV} for explicit compatibility mode`
}

export function logNodeBridgeFallbackDisabled(options: {
  appendStartupLog?: (message: string) => void
  source: NodeBridgeFallbackSource
  reason?: string
  detail?: string
}): void {
  const detail = options.detail ? `, ${options.detail}` : ''
  options.appendStartupLog?.(`${nodeBridgeFallbackDeniedMessage(options.source)}, reason=${options.reason || nodeBridgeFallbackPolicyReason()}${detail}`)
}

export function logNodeBridgeFallbackUsed(options: {
  appendStartupLog?: (message: string) => void
  source: NodeBridgeFallbackSource
  reason?: string
  detail?: string
}): void {
  const detail = options.detail ? `, ${options.detail}` : ''
  options.appendStartupLog?.(`node bridge fallback used: source=${options.source}, reason=${options.reason || nodeBridgeFallbackPolicyReason()}${detail}`)
}
