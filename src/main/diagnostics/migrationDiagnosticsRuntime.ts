import {
  nodeDbQueryFallbackEnabled,
  rustFullMigrationEnabled,
} from '../rust-core/rustFullMigrationPolicyRuntime'
import { nodeFontkitScanFallbackPolicyLogLine, nodeFontkitScanFallbackPolicySnapshot } from '../rust-core/nodeFontkitScanFallbackCompatibilityRuntime'
import { nodeIndexedFallbackPolicyLogLine, nodeIndexedFallbackPolicySnapshot } from '../library/nodeIndexedFallbackCompatibilityRuntime'
import { nodeStateFallbackPolicyLogLine, nodeStateFallbackPolicySnapshot } from '../rust-core/nodeStateFallbackCompatibilityRuntime'
import { rustStateFallbackFailureProtocolSnapshot } from '../rust-core/rustStateFallbackFailureProtocolRuntime'
import { nodeBridgeFallbackPolicyLogLine, nodeBridgeFallbackPolicySnapshot } from '../rust-core/nodeBridgeFallbackCompatibilityRuntime'
import { legacyFallbackAuditCompletionSummary } from '../legacy/fallback/legacyFallbackAuditRuntime'

export type MigrationDiagnosticEventKind =
  | 'accepted'
  | 'rejected'
  | 'fallback-disabled'
  | 'fallback-used'
  | 'fresh-memory'
  | 'cache-clear'

export type MigrationDiagnosticSource =
  | 'rust-page'
  | 'rust-ids'
  | 'rust-metrics'
  | 'db-worker-page'
  | 'db-worker-metrics'
  | 'local-merged-index'
  | 'root-index'
  | 'memory-query'
  | 'font-query-cache'
  | 'tag-revision'
  | string

export type MigrationDiagnosticEvent = {
  at: string
  source: MigrationDiagnosticSource
  kind: MigrationDiagnosticEventKind
  reason?: string
  page?: string
  activeFilterKind?: string
  activeFilterName?: string
  total?: number
  elapsedMs?: number
  tagRevisionToken?: string
}

export type MigrationDiagnosticsSnapshot = {
  policy: {
    rustFullMigration: boolean
    nodeDbQueryFallback: boolean
    nodeFontkitScanFallback: ReturnType<typeof nodeFontkitScanFallbackPolicySnapshot>
    nodeIndexedFallback: ReturnType<typeof nodeIndexedFallbackPolicySnapshot>
    nodeStateFallback: ReturnType<typeof nodeStateFallbackPolicySnapshot>
    rustStateFallbackFailureProtocol: ReturnType<typeof rustStateFallbackFailureProtocolSnapshot>
    nodeBridgeFallback: ReturnType<typeof nodeBridgeFallbackPolicySnapshot>
    legacyFallbackAudit: string
  }
  counters: Record<string, number>
  recentEvents: MigrationDiagnosticEvent[]
  summary: {
    accepted: number
    rejected: number
    fallbackDisabled: number
    fallbackUsed: number
    freshMemory: number
    cacheClears: number
  }
}

export type MigrationDiagnosticsRuntime = {
  record: (event: Omit<MigrationDiagnosticEvent, 'at'>) => void
  snapshot: () => MigrationDiagnosticsSnapshot
  clear: () => void
  logStartupPolicy: () => void
}

const RECENT_EVENT_LIMIT = 160

function counterKey(event: Omit<MigrationDiagnosticEvent, 'at'>): string {
  return `${event.source}:${event.kind}${event.reason ? `:${event.reason}` : ''}`
}

function summarize(counters: Record<string, number>): MigrationDiagnosticsSnapshot['summary'] {
  const summary = {
    accepted: 0,
    rejected: 0,
    fallbackDisabled: 0,
    fallbackUsed: 0,
    freshMemory: 0,
    cacheClears: 0,
  }
  for (const [key, count] of Object.entries(counters)) {
    if (key.includes(':accepted')) summary.accepted += count
    else if (key.includes(':rejected')) summary.rejected += count
    else if (key.includes(':fallback-disabled')) summary.fallbackDisabled += count
    else if (key.includes(':fallback-used')) summary.fallbackUsed += count
    else if (key.includes(':fresh-memory')) summary.freshMemory += count
    else if (key.includes(':cache-clear')) summary.cacheClears += count
  }
  return summary
}

export function createMigrationDiagnosticsRuntime(options: {
  appendStartupLog: (message: string) => void
}): MigrationDiagnosticsRuntime {
  const counters: Record<string, number> = {}
  let recentEvents: MigrationDiagnosticEvent[] = []

  function record(event: Omit<MigrationDiagnosticEvent, 'at'>): void {
    const key = counterKey(event)
    counters[key] = (counters[key] || 0) + 1
    recentEvents = [{ ...event, at: new Date().toISOString() }, ...recentEvents].slice(0, RECENT_EVENT_LIMIT)
  }

  function snapshot(): MigrationDiagnosticsSnapshot {
    return {
      policy: {
        rustFullMigration: rustFullMigrationEnabled(),
        nodeDbQueryFallback: nodeDbQueryFallbackEnabled(),
        nodeFontkitScanFallback: nodeFontkitScanFallbackPolicySnapshot(),
        nodeIndexedFallback: nodeIndexedFallbackPolicySnapshot(),
        nodeStateFallback: nodeStateFallbackPolicySnapshot(),
        rustStateFallbackFailureProtocol: rustStateFallbackFailureProtocolSnapshot(),
        nodeBridgeFallback: nodeBridgeFallbackPolicySnapshot(),
        legacyFallbackAudit: legacyFallbackAuditCompletionSummary(),
      },
      counters: { ...counters },
      recentEvents: recentEvents.map((event) => ({ ...event })),
      summary: summarize(counters),
    }
  }

  function clear(): void {
    for (const key of Object.keys(counters)) delete counters[key]
    recentEvents = []
  }

  function logStartupPolicy(): void {
    const current = snapshot().policy
    options.appendStartupLog(
      `migration diagnostics policy: rustFullMigration=${current.rustFullMigration ? 'on' : 'off'}, nodeDbQueryFallback=${current.nodeDbQueryFallback ? 'on' : 'off'}, ${nodeFontkitScanFallbackPolicyLogLine()}, ${nodeIndexedFallbackPolicyLogLine()}, ${nodeStateFallbackPolicyLogLine()}, ${nodeBridgeFallbackPolicyLogLine()}, rustStateFallbackFailureProtocol=${current.rustStateFallbackFailureProtocol.commands.length} commands policy-gated, legacyFallbackAudit=${current.legacyFallbackAudit}`,
    )
  }

  return { record, snapshot, clear, logStartupPolicy }
}
