import { nodeFontkitScanFallbackEnabled, rustFullMigrationEnabled } from './rustFullMigrationPolicyRuntime'

export type NodeFontkitScanFallbackMode = 'disabled' | 'explicit-compatibility' | 'legacy-node'

export type NodeFontkitScanFallbackPolicySnapshot = {
  mode: NodeFontkitScanFallbackMode
  rustFullMigration: boolean
  nodeFontkitScanFallback: boolean
  requiredEnv: 'HFM_NODE_FONTKIT_SCAN_FALLBACK=1'
  scanParseFallbackRequiresExplicitCompatibility: boolean
  failureLogSuffix: string
}

const REQUIRED_ENV = 'HFM_NODE_FONTKIT_SCAN_FALLBACK=1' as const
const DISABLED_SUFFIX = `fontkit Worker fallback is policy-gated by ${REQUIRED_ENV}`
const ACTIVE_SUFFIX = 'fontkit Worker fallback remains active'

export function nodeFontkitScanFallbackPolicySnapshot(): NodeFontkitScanFallbackPolicySnapshot {
  const rustFullMigration = rustFullMigrationEnabled()
  const nodeFontkitScanFallback = nodeFontkitScanFallbackEnabled()
  const mode: NodeFontkitScanFallbackMode = !rustFullMigration
    ? 'legacy-node'
    : nodeFontkitScanFallback
      ? 'explicit-compatibility'
      : 'disabled'

  return {
    mode,
    rustFullMigration,
    nodeFontkitScanFallback,
    requiredEnv: REQUIRED_ENV,
    scanParseFallbackRequiresExplicitCompatibility: true,
    failureLogSuffix: mode === 'disabled' ? DISABLED_SUFFIX : ACTIVE_SUFFIX,
  }
}

export function nodeFontkitScanFallbackCompatibilityAllowed(): boolean {
  return nodeFontkitScanFallbackPolicySnapshot().mode !== 'disabled'
}

export function nodeFontkitScanFallbackPolicyReason(): string {
  const policy = nodeFontkitScanFallbackPolicySnapshot()
  if (policy.mode === 'legacy-node') return 'rust-full-migration-off'
  if (policy.mode === 'explicit-compatibility') return 'explicit-node-fontkit-scan-fallback'
  return 'rust-full-migration'
}

export function nodeFontkitScanFallbackPolicyLogLine(): string {
  const policy = nodeFontkitScanFallbackPolicySnapshot()
  return `nodeFontkitScanFallback=${policy.mode}, requiredEnv=${policy.requiredEnv}`
}

export function nodeFontkitScanFallbackFailureLogSuffix(): string {
  return nodeFontkitScanFallbackPolicySnapshot().failureLogSuffix
}

export function nodeFontkitScanFallbackDeniedMessage(source: string): string {
  return `rust full migration: ${source} fallback disabled; enable ${REQUIRED_ENV} for explicit compatibility mode`
}

export function logNodeFontkitScanFallbackDisabled(options: {
  appendStartupLog?: (message: string) => void
  source: string
  unresolved?: number
  reason?: string
}): void {
  const unresolved = Number.isFinite(Number(options.unresolved)) ? `, unresolved=${Number(options.unresolved)}` : ''
  options.appendStartupLog?.(`${nodeFontkitScanFallbackDeniedMessage(options.source)}, reason=${options.reason || nodeFontkitScanFallbackPolicyReason()}${unresolved}`)
}

export function logNodeFontkitScanFallbackUsed(options: {
  appendStartupLog?: (message: string) => void
  source: string
  unresolved?: number
  reason?: string
}): void {
  const unresolved = Number.isFinite(Number(options.unresolved)) ? `, unresolved=${Number(options.unresolved)}` : ''
  options.appendStartupLog?.(`node fontkit scan fallback used: source=${options.source}, reason=${options.reason || nodeFontkitScanFallbackPolicyReason()}${unresolved}`)
}
