import type { FontTagMutationProtocolResult } from '../../shared/types'

export type TagMutationProtocolDomain = 'localTags' | 'sharedMetadata'
export type TagMutationProtocolSource = 'rust-worker' | 'rust-daemon' | 'node-fallback'

export type CreateTagMutationProtocolOptions = {
  ok?: boolean
  message?: string
  command: string
  domain: TagMutationProtocolDomain
  mutationKind: string
  source?: TagMutationProtocolSource
  changedIds?: unknown[]
  updatedAt?: string
  dbPath?: string
  rootPath?: string
  knownTags?: unknown[]
  signature?: string
  cacheInvalidated?: boolean
  mergedIndexDirty?: boolean
  pageQueryDirty?: boolean
  metricsDirty?: boolean
  stateSignal?: Record<string, unknown>
  timings?: Record<string, number>
  workerMode?: string
}

function cleanStringArray(value: unknown[] | undefined): string[] {
  return Array.from(
    new Set(
      (Array.isArray(value) ? value : [])
        .map((entry) => String(entry || '').trim())
        .filter(Boolean),
    ),
  )
}

export function createTagMutationProtocolResult(
  options: CreateTagMutationProtocolOptions,
): FontTagMutationProtocolResult {
  const hasKnownTags = Array.isArray(options.knownTags)
  const protocol: FontTagMutationProtocolResult = {
    ok: options.ok ?? true,
    message: options.message,
    command: options.command,
    domain: options.domain,
    mutationKind: options.mutationKind,
    source: options.source || 'node-fallback',
    changedIds: cleanStringArray(options.changedIds),
    updatedAt: options.updatedAt || new Date().toISOString(),
    dbPath: options.dbPath,
    rootPath: options.rootPath,
    knownTags: hasKnownTags ? cleanStringArray(options.knownTags) : undefined,
    signature: options.signature,
    cacheInvalidated: options.cacheInvalidated ?? true,
    mergedIndexDirty: options.mergedIndexDirty ?? options.domain === 'sharedMetadata',
    pageQueryDirty: options.pageQueryDirty ?? true,
    metricsDirty: options.metricsDirty ?? true,
    stateSignal: options.stateSignal,
    timings: options.timings,
    workerMode: options.workerMode || `${options.source || 'node-fallback'}:${options.domain}:${options.mutationKind}`,
  }

  if (!protocol.changedIds?.length) delete protocol.changedIds
  if (!hasKnownTags) delete protocol.knownTags
  if (!protocol.message) delete protocol.message
  if (!protocol.dbPath) delete protocol.dbPath
  if (!protocol.rootPath) delete protocol.rootPath
  if (!protocol.signature) delete protocol.signature
  if (!protocol.stateSignal) delete protocol.stateSignal
  if (!protocol.timings) delete protocol.timings
  return protocol
}
