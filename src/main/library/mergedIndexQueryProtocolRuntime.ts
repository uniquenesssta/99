import type {
  FontMetricsResult,
  FontQueryPageResult,
  FontQueryRequest,
  FontTagRevisionMetadata,
} from '../../shared/types'
import { fontQueryNeedsFreshTagMetadata } from './tagQueryFreshnessRuntime'
import { nodeIndexedFallbackCompatibilityAllowed } from './nodeIndexedFallbackCompatibilityRuntime'

type RevisionLike = {
  localRevision?: unknown
  sharedRevision?: unknown
  localDirtyUntil?: unknown
  sharedDirtyUntil?: unknown
}

type ProtocolDecision = {
  accept: boolean
  reason?: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function revisionNumber(value: unknown, key: keyof RevisionLike): number {
  const record = asRecord(value)
  if (!record) return 0
  const numberValue = Number(record[key] || 0)
  return Number.isFinite(numberValue) ? numberValue : 0
}

function normalizeRequestedRevision(metadata?: FontTagRevisionMetadata): Record<string, unknown> | null {
  return asRecord(metadata?.requested)
}

export function nodeIndexedQueryFallbackAllowed(): boolean {
  return nodeIndexedFallbackCompatibilityAllowed()
}

export function tagRevisionCacheToken(snapshot?: unknown): string {
  const localRevision = revisionNumber(snapshot, 'localRevision')
  const sharedRevision = revisionNumber(snapshot, 'sharedRevision')
  if (!localRevision && !sharedRevision) return ''
  return `tagrev:l${localRevision}:s${sharedRevision}`
}

export function tagRevisionMatchesSnapshot(
  snapshot: unknown,
  metadata?: FontTagRevisionMetadata,
): boolean {
  const requested = normalizeRequestedRevision(metadata)
  if (!requested) return false
  return (
    revisionNumber(snapshot, 'localRevision') === revisionNumber(requested, 'localRevision') &&
    revisionNumber(snapshot, 'sharedRevision') === revisionNumber(requested, 'sharedRevision')
  )
}

export function shouldAcceptIndexedPageProtocol(args: {
  request: FontQueryRequest
  result: FontQueryPageResult | null
  snapshot: unknown
  stale?: boolean
  allowLegacyFallback?: boolean
}): ProtocolDecision {
  if (!args.result) return { accept: false, reason: 'empty-result' }
  if (args.stale) return { accept: false, reason: 'tag-revision-stale' }
  if (!fontQueryNeedsFreshTagMetadata(args.request)) return { accept: true }
  if (tagRevisionMatchesSnapshot(args.snapshot, args.result.tagRevision)) return { accept: true }
  if (args.allowLegacyFallback && Number(args.result.total || 0) > 0) {
    return { accept: true, reason: 'legacy-non-zero-compatible' }
  }
  return { accept: false, reason: 'missing-or-mismatched-tag-revision' }
}

export function shouldAcceptMetricsProtocol(args: {
  result: FontMetricsResult | null
  snapshot: unknown
  allowLegacyFallback?: boolean
}): ProtocolDecision {
  if (!args.result) return { accept: false, reason: 'empty-result' }
  const token = tagRevisionCacheToken(args.snapshot)
  if (!token) return { accept: true }
  if (tagRevisionMatchesSnapshot(args.snapshot, args.result.tagRevision)) return { accept: true }
  if (args.allowLegacyFallback) return { accept: true, reason: 'legacy-metrics-compatible' }
  return { accept: false, reason: 'metrics-missing-or-mismatched-tag-revision' }
}
