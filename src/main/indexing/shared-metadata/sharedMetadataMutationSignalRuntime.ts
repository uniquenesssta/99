import type { RustSharedMetadataMutationStateSignal } from '../../rust-core/rustCoreWorkerRuntime'

export type SharedMetadataMutationSignalSource = 'rust-worker' | 'node-fallback'
export type SharedMetadataMutationStateSignalHandler = (signal: RustSharedMetadataMutationStateSignal) => void

export function normalizeSharedMetadataMutationStateSignal(
  signal: RustSharedMetadataMutationStateSignal | undefined,
  fallbackRoot: string,
  mutationKind: string,
  changedIds: string[] = [],
  source: SharedMetadataMutationSignalSource = 'node-fallback',
): RustSharedMetadataMutationStateSignal {
  const kind = signal?.mutationKind || mutationKind
  const normalizedChangedIds = Array.isArray(signal?.changedIds) ? signal?.changedIds : changedIds
  const hasChangedRows = normalizedChangedIds.length > 0
  const sharedMetadataChanged = signal?.sharedMetadataChanged ?? hasChangedRows
  return {
    mutationKind: kind,
    dbPath: signal?.dbPath,
    rootPath: signal?.rootPath || fallbackRoot,
    changedIds: normalizedChangedIds,
    updatedAt: signal?.updatedAt || new Date().toISOString(),
    signature: signal?.signature,
    sharedMetadataChanged,
    cacheInvalidated: signal?.cacheInvalidated ?? sharedMetadataChanged,
    mergedIndexDirty: signal?.mergedIndexDirty ?? sharedMetadataChanged,
    pageQueryDirty: signal?.pageQueryDirty ?? sharedMetadataChanged,
    metricsDirty: signal?.metricsDirty ?? sharedMetadataChanged,
    source: signal?.source || source,
  }
}

export function emitSharedMetadataMutationStateSignal(
  handler: SharedMetadataMutationStateSignalHandler | undefined,
  signal: RustSharedMetadataMutationStateSignal | undefined,
  fallbackRoot: string,
  mutationKind: string,
  changedIds: string[] = [],
  source: SharedMetadataMutationSignalSource = 'node-fallback',
): RustSharedMetadataMutationStateSignal {
  const normalized = normalizeSharedMetadataMutationStateSignal(signal, fallbackRoot, mutationKind, changedIds, source)
  try {
    handler?.(normalized)
  } catch {
    // Cache invalidation signals must not break the completed metadata transaction.
  }
  return normalized
}

export function sharedMetadataMutationSignalSummary(
  signal: RustSharedMetadataMutationStateSignal | undefined,
  fallbackRoot: string,
): string {
  if (!signal) return `root=${fallbackRoot}, signal=none`
  const changedIds = Array.isArray(signal.changedIds) ? signal.changedIds : []
  const root = signal.rootPath || fallbackRoot
  const dirty = [
    signal.sharedMetadataChanged ? 'shared-metadata' : '',
    signal.cacheInvalidated ? 'cache' : '',
    signal.mergedIndexDirty ? 'merged-index' : '',
    signal.pageQueryDirty ? 'page-query' : '',
    signal.metricsDirty ? 'metrics' : '',
  ].filter(Boolean).join('+') || 'none'
  return [
    `root=${root}`,
    `kind=${signal.mutationKind || 'unknown'}`,
    `changed=${changedIds.length}`,
    `dirty=${dirty}`,
    signal.source ? `source=${signal.source}` : '',
    signal.signature ? `signature=${signal.signature}` : '',
  ].filter(Boolean).join(', ')
}
