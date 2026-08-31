import type { FontQueryRequest } from '../../shared/types'
import { fontQueryNeedsFreshTagMetadata } from './tagQueryFreshnessRuntime'

export type TagMetadataScope = 'local' | 'shared'

export type TagMetadataRevisionSnapshot = {
  localRevision: number
  sharedRevision: number
  localDirtyUntil: number
  sharedDirtyUntil: number
}

export type TagMetadataMutationInput = {
  scope: TagMetadataScope
  reason: string
  fontIds?: string[]
}

const TAG_METADATA_BARRIER_MS = 2_000
const TAG_METADATA_INDEXED_QUERY_GRACE_MS = 220
const CHANGED_ID_LIMIT = 4_000

function cleanId(value: unknown): string {
  return String(value || '').trim()
}

function requestUsesLocalTags(request: FontQueryRequest): boolean {
  const sidebarPage = request.sidebarPage || 'library'
  const kind = request.activeFilter?.kind || 'all'
  return sidebarPage === 'tags' || kind === 'tag'
}

function requestUsesSharedTags(request: FontQueryRequest): boolean {
  const sidebarPage = request.sidebarPage || 'library'
  const kind = request.activeFilter?.kind || 'all'
  return sidebarPage === 'sharedTags' || kind === 'sharedTag'
}

function addChangedIds(target: Set<string>, ids: string[]): void {
  for (const id of ids.map(cleanId).filter(Boolean)) {
    target.add(id)
    if (target.size > CHANGED_ID_LIMIT) {
      const first = target.values().next().value
      if (first) target.delete(first)
    }
  }
}

export function createTagMetadataRevisionBarrierRuntime(options: {
  appendStartupLog: (message: string) => void
}) {
  let localRevision = 0
  let sharedRevision = 0
  let localDirtyUntil = 0
  let sharedDirtyUntil = 0
  let localLastReason = ''
  let sharedLastReason = ''
  let localLastMutationAt = 0
  let sharedLastMutationAt = 0
  let lastFastMetricsInvalidationToken = ''
  const localChangedIds = new Set<string>()
  const sharedChangedIds = new Set<string>()

  function snapshot(): TagMetadataRevisionSnapshot {
    return {
      localRevision,
      sharedRevision,
      localDirtyUntil,
      sharedDirtyUntil,
    }
  }

  function noteMutation(input: TagMetadataMutationInput): TagMetadataRevisionSnapshot {
    const now = Date.now()
    const ids = (input.fontIds || []).map(cleanId).filter(Boolean)
    if (input.scope === 'local') {
      localRevision += 1
      localDirtyUntil = now + TAG_METADATA_BARRIER_MS
      localLastMutationAt = now
      localLastReason = input.reason || 'local-tag-mutation'
      addChangedIds(localChangedIds, ids)
      options.appendStartupLog(
        `tag metadata revision barrier: scope=local, revision=${localRevision}, ids=${ids.length}, reason=${localLastReason}`,
      )
    } else {
      sharedRevision += 1
      sharedDirtyUntil = now + TAG_METADATA_BARRIER_MS
      sharedLastMutationAt = now
      sharedLastReason = input.reason || 'shared-tag-mutation'
      addChangedIds(sharedChangedIds, ids)
      options.appendStartupLog(
        `tag metadata revision barrier: scope=shared, revision=${sharedRevision}, ids=${ids.length}, reason=${sharedLastReason}`,
      )
    }
    return snapshot()
  }

  function noteLocalTagMutation(reason: string, fontIds?: string[]): TagMetadataRevisionSnapshot {
    return noteMutation({ scope: 'local', reason, fontIds })
  }

  function noteSharedTagMutation(reason: string, fontIds?: string[]): TagMetadataRevisionSnapshot {
    return noteMutation({ scope: 'shared', reason, fontIds })
  }

  function snapshotForRequest(request: FontQueryRequest): TagMetadataRevisionSnapshot {
    if (!fontQueryNeedsFreshTagMetadata(request)) return { localRevision: 0, sharedRevision: 0, localDirtyUntil: 0, sharedDirtyUntil: 0 }
    const usesLocal = requestUsesLocalTags(request)
    const usesShared = requestUsesSharedTags(request)
    return {
      localRevision: usesLocal || (!usesLocal && !usesShared) ? localRevision : 0,
      sharedRevision: usesShared || (!usesLocal && !usesShared) ? sharedRevision : 0,
      localDirtyUntil: usesLocal ? localDirtyUntil : 0,
      sharedDirtyUntil: usesShared ? sharedDirtyUntil : 0,
    }
  }

  function cacheKeySuffixForRequest(request: FontQueryRequest): string {
    const token = snapshotForRequest(request)
    if (!token.localRevision && !token.sharedRevision) return ''
    return `tagrev:l${token.localRevision}:s${token.sharedRevision}`
  }

  function resultBecameStaleForRequest(request: FontQueryRequest, token: TagMetadataRevisionSnapshot): boolean {
    if (!fontQueryNeedsFreshTagMetadata(request)) return false
    const usesLocal = requestUsesLocalTags(request)
    const usesShared = requestUsesSharedTags(request)
    return (
      (usesLocal && localRevision !== token.localRevision) ||
      (usesShared && sharedRevision !== token.sharedRevision)
    )
  }

  function hasActiveBarrierForRequest(request: FontQueryRequest, now = Date.now()): boolean {
    if (!fontQueryNeedsFreshTagMetadata(request)) return false
    return (
      (requestUsesLocalTags(request) && localDirtyUntil > now) ||
      (requestUsesSharedTags(request) && sharedDirtyUntil > now)
    )
  }

  function indexedQueryDelayMsForRequest(request: FontQueryRequest, now = Date.now()): number {
    if (!fontQueryNeedsFreshTagMetadata(request)) return 0
    const usesLocal = requestUsesLocalTags(request)
    const usesShared = requestUsesSharedTags(request)
    const latestMutationAt = Math.max(usesLocal ? localLastMutationAt : 0, usesShared ? sharedLastMutationAt : 0)
    if (!latestMutationAt) return 0
    const elapsedMs = now - latestMutationAt
    if (elapsedMs < 0 || elapsedMs >= TAG_METADATA_INDEXED_QUERY_GRACE_MS) return 0
    return TAG_METADATA_INDEXED_QUERY_GRACE_MS - elapsedMs
  }

  function shouldBypassIndexedPageQuery(_request: FontQueryRequest, _now = Date.now()): boolean {
    return false
  }

  function shouldBypassFastMetrics(now = Date.now()): boolean {
    if (localDirtyUntil <= now && sharedDirtyUntil <= now) return false
    const token = `l${localRevision}:s${sharedRevision}`
    if (token === lastFastMetricsInvalidationToken) return false
    lastFastMetricsInvalidationToken = token
    return true
  }

  function describe(): string {
    return `local=${localRevision}${localDirtyUntil > Date.now() ? ':dirty' : ''}(${localLastReason || 'none'}), shared=${sharedRevision}${sharedDirtyUntil > Date.now() ? ':dirty' : ''}(${sharedLastReason || 'none'})`
  }

  return {
    snapshot,
    noteMutation,
    noteLocalTagMutation,
    noteSharedTagMutation,
    snapshotForRequest,
    cacheKeySuffixForRequest,
    resultBecameStaleForRequest,
    hasActiveBarrierForRequest,
    indexedQueryDelayMsForRequest,
    shouldBypassIndexedPageQuery,
    shouldBypassFastMetrics,
    describe,
  }
}

export type TagMetadataRevisionBarrierRuntime = ReturnType<typeof createTagMetadataRevisionBarrierRuntime>
