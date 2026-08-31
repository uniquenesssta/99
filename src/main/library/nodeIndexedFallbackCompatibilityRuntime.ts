import type { FontQueryRequest } from '../../shared/types'
import { nodeDbQueryFallbackEnabled, rustFullMigrationEnabled } from '../rust-core/rustFullMigrationPolicyRuntime'
import { fontQueryNeedsFreshTagMetadata } from './tagQueryFreshnessRuntime'

export type NodeIndexedFallbackSource =
  | 'db-worker-page'
  | 'db-worker-metrics'
  | 'local-merged-index'
  | 'root-index'
  | 'db-worker-ids'
  | string

export type NodeIndexedFallbackMode = 'disabled' | 'explicit-compatibility' | 'legacy-node'

export type NodeIndexedFallbackPolicySnapshot = {
  mode: NodeIndexedFallbackMode
  rustFullMigration: boolean
  nodeDbQueryFallback: boolean
  requiredEnv: 'HFM_NODE_DB_QUERY_FALLBACK=1'
  tagSensitiveFallbackRequiresProtocol: boolean
}

type DiagnosticRecorder = {
  record: (event: {
    source: string
    kind: 'accepted' | 'rejected' | 'fallback-disabled' | 'fallback-used' | 'fresh-memory' | 'cache-clear'
    reason?: string
    page?: string
    activeFilterKind?: string
    activeFilterName?: string
    total?: number
    elapsedMs?: number
    tagRevisionToken?: string
  }) => void
}

export function nodeIndexedFallbackPolicySnapshot(): NodeIndexedFallbackPolicySnapshot {
  const rustFullMigration = rustFullMigrationEnabled()
  const nodeDbQueryFallback = nodeDbQueryFallbackEnabled()
  return {
    mode: !rustFullMigration ? 'legacy-node' : nodeDbQueryFallback ? 'explicit-compatibility' : 'disabled',
    rustFullMigration,
    nodeDbQueryFallback,
    requiredEnv: 'HFM_NODE_DB_QUERY_FALLBACK=1',
    tagSensitiveFallbackRequiresProtocol: true,
  }
}

export function nodeIndexedFallbackCompatibilityAllowed(): boolean {
  return nodeIndexedFallbackPolicySnapshot().mode !== 'disabled'
}

export function nodeIndexedFallbackPolicyReason(): string {
  const policy = nodeIndexedFallbackPolicySnapshot()
  if (policy.mode === 'legacy-node') return 'rust-full-migration-off'
  if (policy.mode === 'explicit-compatibility') return 'explicit-node-db-fallback'
  return 'rust-full-migration'
}

export function nodeIndexedFallbackPolicyLogLine(): string {
  const policy = nodeIndexedFallbackPolicySnapshot()
  return `nodeIndexedFallback=${policy.mode}, requiredEnv=${policy.requiredEnv}`
}

export function recordNodeIndexedFallbackDisabled(args: {
  diagnostics?: DiagnosticRecorder
  source: NodeIndexedFallbackSource
  request?: FontQueryRequest
  tagRevisionToken?: string
  reason?: string
}): void {
  args.diagnostics?.record({
    source: args.source,
    kind: 'fallback-disabled',
    reason: args.reason || nodeIndexedFallbackPolicyReason(),
    page: args.request?.sidebarPage || 'library',
    activeFilterKind: args.request?.activeFilter?.kind || 'all',
    activeFilterName: args.request?.activeFilter?.name || '',
    tagRevisionToken: args.tagRevisionToken,
  })
}

export function recordNodeIndexedFallbackUsed(args: {
  diagnostics?: DiagnosticRecorder
  source: NodeIndexedFallbackSource
  request?: FontQueryRequest
  tagRevisionToken?: string
  reason?: string
  total?: number
  elapsedMs?: number
}): void {
  args.diagnostics?.record({
    source: args.source,
    kind: 'fallback-used',
    reason: args.reason || nodeIndexedFallbackPolicyReason(),
    page: args.request?.sidebarPage || 'library',
    activeFilterKind: args.request?.activeFilter?.kind || 'all',
    activeFilterName: args.request?.activeFilter?.name || '',
    total: args.total,
    elapsedMs: args.elapsedMs,
    tagRevisionToken: args.tagRevisionToken,
  })
}

export function nodeIndexedFallbackDeniedMessage(source: NodeIndexedFallbackSource, request?: FontQueryRequest): string {
  const page = request?.sidebarPage || 'library'
  const activeFilter = request?.activeFilter?.kind || 'all'
  return `rust full migration: ${source} fallback disabled; enable HFM_NODE_DB_QUERY_FALLBACK=1 for explicit compatibility mode, page=${page}, activeFilter=${activeFilter}`
}

export function nodeIndexedFallbackRequiresFreshProtocol(request?: FontQueryRequest): boolean {
  return !!request && fontQueryNeedsFreshTagMetadata(request)
}
