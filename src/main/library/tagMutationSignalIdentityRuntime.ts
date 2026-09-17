import { createHash } from 'node:crypto'

// Internal receipt identity only. No database identity, trace, or transport ownership.
type SignalIdentityInput = {
  mutationId?: string
  mutationKind?: string
  dbPath?: string
  rootPath?: string
  changedIds?: string[]
  knownTags?: string[]
  updatedAt?: string
  signature?: string
  localTagsChanged?: boolean
  sharedMetadataChanged?: boolean
  cacheInvalidated?: boolean
  pageQueryDirty?: boolean
  metricsDirty?: boolean
  mergedIndexDirty?: boolean
}

function canonicalStrings(values: string[]): string[] {
  return Array.from(new Set(values)).sort()
}

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function createTagMutationSignalIdentityRuntime() {
  // One bounded owner per signal runtime. Time is retention, never causal order.
  const seen = new Map<string, number>()
  return function identify(scope: 'local' | 'shared', signal: SignalIdentityInput): { apply: boolean; reason: 'new' | 'duplicate' | 'legacy'; identity: string } {
    const now = performance.now()
    for (const [key, at] of seen) {
      if (now - at > 60_000) seen.delete(key)
    }
    if (!hasText(signal.mutationId) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(signal.mutationId)
      || !hasText(signal.mutationKind) || !Array.isArray(signal.changedIds)
      || !signal.changedIds.every(id => typeof id === 'string')
      || !(scope === 'local' ? hasText(signal.dbPath) : hasText(signal.rootPath) || hasText(signal.dbPath))) {
      // Old sidecars lack a receipt. A similar payload cannot prove the same commit.
      return { apply: true, reason: 'legacy', identity: 'unavailable' }
    }
    const identity = createHash('sha256').update(JSON.stringify([
      scope, signal.dbPath, signal.rootPath, signal.mutationId,
      signal.mutationKind, signal.updatedAt, canonicalStrings(signal.changedIds),
      Array.isArray(signal.knownTags) ? canonicalStrings(signal.knownTags) : null,
      signal.signature,
      scope === 'local' ? signal.localTagsChanged !== false : signal.sharedMetadataChanged !== false,
      signal.cacheInvalidated !== false, signal.pageQueryDirty !== false, signal.metricsDirty !== false,
      scope === 'shared' ? signal.mergedIndexDirty !== false : null,
    ])).digest('hex')
    if (seen.has(identity)) return { apply: false, reason: 'duplicate', identity }
    seen.set(identity, now)
    while (seen.size > 2048) {
      const oldest = seen.keys().next().value
      if (oldest === undefined) break
      seen.delete(oldest)
    }
    return { apply: true, reason: 'new', identity }
  }
}
