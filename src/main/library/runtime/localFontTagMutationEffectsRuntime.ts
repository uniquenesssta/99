import type { FontTagUpdateResult } from "../../../shared/types";
import type { LocalFontTagsRuntimeDeps, RustLocalTagsMutationStateSignal } from "./localFontTagsRuntime";
import { cleanKnownTagNames } from "./localFontTagNodePersistenceRuntime";
import { createTagMutationProtocolResult } from "../tagMutationProtocolResultRuntime";

function knownTagLifecycle(previousInput: string[] | undefined, nextInput: string[] | undefined): {
  previous: string[]
  next: string[]
  added: string[]
  removed: string[]
} {
  const previous = cleanKnownTagNames(previousInput || [])
  const next = cleanKnownTagNames(nextInput || [])
  const previousSet = new Set(previous)
  const nextSet = new Set(next)
  return {
    previous,
    next,
    added: next.filter((tag) => !previousSet.has(tag)),
    removed: previous.filter((tag) => !nextSet.has(tag)),
  }
}

export function logKnownLocalTagLifecycle(options: {
  appendStartupLog?: (message: string) => void
  kind: string
  source: 'rust-worker' | 'node-fallback'
  changedIds: string[]
  previousKnownTags?: string[]
  knownTags?: string[]
  addedKnownTags?: string[]
  removedKnownTags?: string[]
  retainedEmptyTags?: string[]
}): void {
  const appendStartupLog = (message: string): void => {
    try {
      options.appendStartupLog?.(message)
    } catch {
      // Logging must not change a completed tag mutation or suppress its state signal.
    }
  }
  const hasLifecycleBaseline = Array.isArray(options.previousKnownTags) || Array.isArray(options.addedKnownTags) || Array.isArray(options.removedKnownTags)
  if (!hasLifecycleBaseline) return
  const lifecycle = knownTagLifecycle(options.previousKnownTags, options.knownTags)
  const added = cleanKnownTagNames(options.addedKnownTags || lifecycle.added)
  const removed = cleanKnownTagNames(options.removedKnownTags || lifecycle.removed)
  const retainedEmpty = cleanKnownTagNames(options.retainedEmptyTags || [])
  if (retainedEmpty.length) {
    appendStartupLog(`local known tag retained empty: source=${options.source}, kind=${options.kind}, tags=${JSON.stringify(retainedEmpty)}, catalog=${lifecycle.next.length}, changedFonts=${options.changedIds.length}`)
  }
  if (removed.length) {
    appendStartupLog(`local known tag deleted: source=${options.source}, kind=${options.kind}, tags=${JSON.stringify(removed)}, previous=${lifecycle.previous.length}, next=${lifecycle.next.length}, changedFonts=${options.changedIds.length}`)
  }
  if (added.length) {
    appendStartupLog(`local known tag created: source=${options.source}, kind=${options.kind}, tags=${JSON.stringify(added)}, previous=${lifecycle.previous.length}, next=${lifecycle.next.length}, changedFonts=${options.changedIds.length}`)
  }
}

export function createLocalFontTagMutationEffectsRuntime(deps: Pick<LocalFontTagsRuntimeDeps, 'librarySqlitePath' | 'onLocalTagsMutationStateSignal'>) {
  function emitLocalTagsMutationStateSignal(
    kind: string,
    updatedAt: string,
    changedIds: string[],
    knownTags?: string[],
    signal?: RustLocalTagsMutationStateSignal,
    source: 'rust-worker' | 'node-fallback' | 'rust-daemon' = 'node-fallback',
    catalogChanged = false,
  ): RustLocalTagsMutationStateSignal {
    const normalizedChangedIds = Array.isArray(signal?.changedIds) ? signal?.changedIds : changedIds;
    const changed = normalizedChangedIds.length > 0 || catalogChanged;
    const normalized: RustLocalTagsMutationStateSignal = {
      mutationKind: signal?.mutationKind || kind,
      dbPath: signal?.dbPath || deps.librarySqlitePath(),
      changedIds: normalizedChangedIds,
      updatedAt: signal?.updatedAt || updatedAt,
      localTagsChanged: signal?.localTagsChanged ?? changed,
      cacheInvalidated: signal?.cacheInvalidated ?? changed,
      pageQueryDirty: signal?.pageQueryDirty ?? changed,
      metricsDirty: signal?.metricsDirty ?? changed,
      knownTags: knownTags || signal?.knownTags,
      source: signal?.source || source,
    };
    try {
      deps.onLocalTagsMutationStateSignal?.(normalized);
    } catch {
      // State signals must not break the completed local tag write.
    }
    return normalized;
  }

  function nodeLocalTagsMutationProtocol(options: {
    command: string
    mutationKind: string
    message: string
    updatedAt: string
    changedIds: string[]
    knownTags?: string[]
    stateSignal?: RustLocalTagsMutationStateSignal
    ok?: boolean
  }): FontTagUpdateResult['mutationProtocol'] {
    return createTagMutationProtocolResult({
      ok: options.ok ?? true,
      message: options.message,
      command: options.command,
      domain: 'localTags',
      mutationKind: options.mutationKind,
      source: 'node-fallback',
      changedIds: options.changedIds,
      updatedAt: options.updatedAt,
      dbPath: deps.librarySqlitePath(),
      knownTags: options.knownTags,
      cacheInvalidated: true,
      mergedIndexDirty: false,
      pageQueryDirty: true,
      metricsDirty: true,
      stateSignal: options.stateSignal as Record<string, unknown> | undefined,
      workerMode: `node-fallback:localTags:${options.mutationKind}`,
    });
  }

  return { emitLocalTagsMutationStateSignal, nodeLocalTagsMutationProtocol };
}
