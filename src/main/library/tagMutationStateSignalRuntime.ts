import { BrowserWindow } from 'electron'
import type { FontTagMutationStateSignalPayload } from '../../shared/types'
import type { TagMetadataRevisionBarrierRuntime } from './tagMetadataRevisionBarrierRuntime'

export type TagMutationSignalSource = FontTagMutationStateSignalPayload['source']

export type LocalTagsMutationStateSignalInput = {
  mutationKind?: string
  dbPath?: string
  changedIds?: string[]
  updatedAt?: string
  localTagsChanged?: boolean
  cacheInvalidated?: boolean
  pageQueryDirty?: boolean
  metricsDirty?: boolean
  knownTags?: string[]
  source?: TagMutationSignalSource
}

export type SharedMetadataMutationStateSignalInput = {
  mutationKind?: string
  rootPath?: string
  changedIds?: string[]
  updatedAt?: string
  sharedMetadataChanged?: boolean
  cacheInvalidated?: boolean
  mergedIndexDirty?: boolean
  pageQueryDirty?: boolean
  metricsDirty?: boolean
  source?: TagMutationSignalSource
}

export type RustCoreDaemonTagDomainEvent = {
  domain?: string
  event?: string
  command?: string
  stateSignal?: unknown
  mutationProtocol?: unknown
  indexProtocol?: unknown
}

export type TagMutationStateSignalRuntimeOptions = {
  tagMetadataRevisionBarrier: TagMetadataRevisionBarrierRuntime
  clearFontQueryCaches: () => void
  appendStartupLog: (message: string) => void
}

function cleanSignalIds(ids: unknown): string[] {
  return Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => String(id || '').trim()).filter(Boolean)))
}

function tagMutationSignalKey(scope: 'local' | 'shared', signal: { mutationKind?: string; updatedAt?: string; changedIds?: string[] }): string {
  const ids = cleanSignalIds(signal.changedIds).slice(0, 80).join('\u0000')
  return `${scope}|${signal.mutationKind || 'unknown'}|${signal.updatedAt || ''}|${ids}`
}

function broadcastFontTagMutationStateSignal(payload: FontTagMutationStateSignalPayload): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('font-tags:stateSignal', payload)
  }
}

export function createTagMutationStateSignalRuntime(options: TagMutationStateSignalRuntimeOptions) {
  const tagMutationSignalDedupe = new Map<string, { at: number; hasKnownTags: boolean }>()

  function shouldApplyTagMutationSignal(scope: 'local' | 'shared', signal: { mutationKind?: string; updatedAt?: string; changedIds?: string[]; knownTags?: string[] }): boolean {
    const now = Date.now()
    for (const [key, entry] of tagMutationSignalDedupe) {
      if (now - entry.at > 60_000) tagMutationSignalDedupe.delete(key)
    }
    const key = tagMutationSignalKey(scope, signal)
    const hasKnownTags = Array.isArray(signal.knownTags)
    const previous = tagMutationSignalDedupe.get(key)
    if (previous && (!hasKnownTags || previous.hasKnownTags)) return false
    tagMutationSignalDedupe.set(key, { at: now, hasKnownTags: hasKnownTags || previous?.hasKnownTags === true })
    return true
  }

  function handleLocalTagsMutationStateSignal(signal: LocalTagsMutationStateSignalInput, source: TagMutationSignalSource = 'rust-worker'): void {
    const effectiveSource = signal.source || source
    const changedIds = cleanSignalIds(signal.changedIds)
    const dirty = signal.localTagsChanged !== false || signal.cacheInvalidated !== false || signal.pageQueryDirty !== false || signal.metricsDirty !== false
    if (!dirty && !changedIds.length) {
      options.appendStartupLog(`local tags mutation signal ignored: source=${effectiveSource}, db=${signal.dbPath || 'unknown'}, kind=${signal.mutationKind || 'unknown'}, changed=0, dirty=false`)
      return
    }
    if (!shouldApplyTagMutationSignal('local', { mutationKind: signal.mutationKind, updatedAt: signal.updatedAt, changedIds, knownTags: signal.knownTags })) return
    const snapshot = options.tagMetadataRevisionBarrier.noteLocalTagMutation(
      `local-tags-signal:${signal.mutationKind || 'unknown'}:${effectiveSource}`,
      changedIds,
    )
    options.clearFontQueryCaches()
    broadcastFontTagMutationStateSignal({
      scope: 'local',
      mutationKind: signal.mutationKind || 'unknown',
      changedIds,
      updatedAt: signal.updatedAt || new Date().toISOString(),
      source: effectiveSource,
      localRevision: snapshot.localRevision,
      sharedRevision: snapshot.sharedRevision,
      knownTags: Array.isArray(signal.knownTags) ? signal.knownTags : undefined,
      dirty: {
        cache: signal.cacheInvalidated !== false,
        pageQuery: signal.pageQueryDirty !== false,
        metrics: signal.metricsDirty !== false,
      },
    })
    options.appendStartupLog(`local tags mutation signal applied: source=${effectiveSource}, db=${signal.dbPath || 'unknown'}, kind=${signal.mutationKind || 'unknown'}, changed=${changedIds.length}`)
  }

  function handleSharedMetadataMutationStateSignal(signal: SharedMetadataMutationStateSignalInput, source: TagMutationSignalSource = 'rust-worker'): void {
    const effectiveSource = signal.source || source
    const changedIds = cleanSignalIds(signal.changedIds)
    const dirty = signal.sharedMetadataChanged !== false || signal.cacheInvalidated !== false || signal.pageQueryDirty !== false || signal.metricsDirty !== false || signal.mergedIndexDirty === true
    if (!dirty && !changedIds.length) {
      options.appendStartupLog(`shared metadata mutation signal ignored: source=${effectiveSource}, root=${signal.rootPath || 'unknown'}, kind=${signal.mutationKind || 'unknown'}, changed=0, dirty=false`)
      return
    }
    if (!shouldApplyTagMutationSignal('shared', { mutationKind: signal.mutationKind, updatedAt: signal.updatedAt, changedIds })) return
    const snapshot = options.tagMetadataRevisionBarrier.noteSharedTagMutation(
      `shared-metadata-signal:${signal.mutationKind || 'unknown'}:${effectiveSource}`,
      changedIds,
    )
    options.clearFontQueryCaches()
    broadcastFontTagMutationStateSignal({
      scope: 'shared',
      mutationKind: signal.mutationKind || 'unknown',
      changedIds,
      updatedAt: signal.updatedAt || new Date().toISOString(),
      source: effectiveSource,
      localRevision: snapshot.localRevision,
      sharedRevision: snapshot.sharedRevision,
      dirty: {
        cache: signal.cacheInvalidated !== false,
        pageQuery: signal.pageQueryDirty !== false,
        metrics: signal.metricsDirty !== false,
        mergedIndex: signal.mergedIndexDirty !== false,
      },
    })
    options.appendStartupLog(`shared metadata mutation signal applied: source=${effectiveSource}, root=${signal.rootPath || 'unknown'}, kind=${signal.mutationKind || 'unknown'}, changed=${changedIds.length}`)
  }

  
function signalFromMutationProtocol(protocol: unknown): unknown {
  if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) return undefined
  const stateSignal = (protocol as { stateSignal?: unknown }).stateSignal
  return stateSignal && typeof stateSignal === 'object' && !Array.isArray(stateSignal) ? stateSignal : undefined
}

function indexProtocolDirty(protocol: unknown): boolean {
  if (!protocol || typeof protocol !== 'object' || Array.isArray(protocol)) return false
  const value = protocol as { cacheInvalidated?: unknown; pageQueryDirty?: unknown; metricsDirty?: unknown; mergedIndexDirty?: unknown }
  return value.cacheInvalidated !== false || value.pageQueryDirty !== false || value.metricsDirty !== false || value.mergedIndexDirty === true
}


  function handleRustCoreDaemonDomainEvent(event: RustCoreDaemonTagDomainEvent): void {
    if (event.domain === 'index' && indexProtocolDirty(event.indexProtocol)) {
      options.clearFontQueryCaches()
      options.appendStartupLog(`merged index protocol event applied: command=${event.command || 'unknown'}`)
      return
    }
    const stateSignal = event.stateSignal && typeof event.stateSignal === 'object' ? event.stateSignal : signalFromMutationProtocol(event.mutationProtocol)
    if (!stateSignal || typeof stateSignal !== 'object') return
    if (event.domain === 'localTags') {
      handleLocalTagsMutationStateSignal(stateSignal as LocalTagsMutationStateSignalInput, 'rust-daemon')
      return
    }
    if (event.domain === 'sharedMetadata') {
      handleSharedMetadataMutationStateSignal(stateSignal as SharedMetadataMutationStateSignalInput, 'rust-daemon')
    }
  }

  return {
    handleLocalTagsMutationStateSignal,
    handleSharedMetadataMutationStateSignal,
    handleRustCoreDaemonDomainEvent,
  }
}
