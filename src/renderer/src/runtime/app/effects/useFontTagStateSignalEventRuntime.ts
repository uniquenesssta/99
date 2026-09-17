import { reportFontOperation } from '../../../fontOperationTrace'
import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { FontTagMutationStateSignalPayload, LibraryState } from '@shared/types'
import { applyFontTagMutationSignalToLibrary } from '../../../fontTagStateAuthorityRuntime'
import { reportRendererTrace } from '../../../rendererPerformance'

export function useFontTagStateSignalEventRuntime(args: {
  hfm: Window['hfm']
  getCurrentLibrary: () => LibraryState
  commitLibraryUpdate: (update: SetStateAction<LibraryState>) => LibraryState
  saveLibraryImmediately: (nextLibrary: LibraryState) => Promise<boolean>
  refreshDatabaseDerivedState: () => void
  setStatus: Dispatch<SetStateAction<string>>
}): void {
  const argsRef = useRef(args)
  argsRef.current = args

  useEffect(() => {
    if (typeof args.hfm.onFontTagStateSignal !== 'function') return

    const dispose = args.hfm.onFontTagStateSignal((payload: FontTagMutationStateSignalPayload) => {
      const current = argsRef.current
      const previousLibrary = current.getCurrentLibrary()
      const nextLibrary = applyFontTagMutationSignalToLibrary(previousLibrary, payload)
      current.commitLibraryUpdate(nextLibrary)
      reportFontOperation({ trace: payload.trace, stage: nextLibrary === previousLibrary ? 'view-reject' : 'view-apply', reason: nextLibrary === previousLibrary ? 'stale-tag-authority-signal' : 'tag-authority-signal', localRevision: payload.localRevision, sharedRevision: payload.sharedRevision })
      current.refreshDatabaseDerivedState()
      reportRendererTrace({
        kind: 'tag-authority-applied',
        label: payload.scope === 'shared' ? 'shared-tags' : 'local-tags',
        durationMs: 0,
        details: {
          mutationKind: payload.mutationKind || 'unknown',
          source: payload.source || 'unknown',
          changedFonts: Array.isArray(payload.changedIds) ? payload.changedIds.length : 0,
          knownTags: Array.isArray(payload.knownTags) ? payload.knownTags.length : -1
        }
      })

      // This is a backend read receipt, not a new user edit. Writing the whole
      // renderer snapshot back here can resurrect a catalog deleted in flight.
      const changed = Array.isArray(payload.changedIds) ? payload.changedIds.length : 0
      current.setStatus(`${payload.scope === 'shared' ? '共享标签' : '本地标签'}更新已接收：${changed} 个字体。`)
    })

    return () => dispose()
  }, [args.hfm])
}
