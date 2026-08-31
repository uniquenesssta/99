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
      const nextLibrary = applyFontTagMutationSignalToLibrary(current.getCurrentLibrary(), payload)
      current.commitLibraryUpdate(nextLibrary)
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

      void (async () => {
        const saved = await current.saveLibraryImmediately(nextLibrary)
        const changed = Array.isArray(payload.changedIds) ? payload.changedIds.length : 0
        current.setStatus(saved
          ? `${payload.scope === 'shared' ? '共享标签' : '本地标签'}写入已确认：${changed} 个字体。`
          : `${payload.scope === 'shared' ? '共享标签' : '本地标签'}后端写入已确认，但本地库状态保存失败。`)
      })()
    })

    return () => dispose()
  }, [args.hfm])
}
