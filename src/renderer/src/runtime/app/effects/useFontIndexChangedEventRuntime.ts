import { useEffect, useRef } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { FontIndexChangePayload, FontItem, LibraryState } from '@shared/types'
import { applyFontIndexChangeToLibrary } from '../../../appRuntime'
import { cleanupRemovedIndexedFontsFromRendererState, fontIndexChangeStatusText } from '../../../fontIndexEventRuntime'
import type { PreviewQueueEntry } from '../../../appRuntime'

export function useFontIndexChangedEventRuntime(args: {
  hfm: Window['hfm']
  selectedFontId: string
  previewQueue: MutableRefObject<PreviewQueueEntry[]>
  autoPreviewCacheQueue: MutableRefObject<FontItem[]>
  queuedPreviewFontIds: MutableRefObject<Set<string>>
  queuedAutoPreviewCacheIds: MutableRefObject<Set<string>>
  loadingFonts: MutableRefObject<Set<string>>
  captureFontScrollSnapshot: () => unknown
  restoreFontScrollSnapshot: (snapshot: any) => void
  getCurrentLibrary: () => LibraryState
  commitLibraryUpdate: (update: SetStateAction<LibraryState>) => LibraryState
  saveLibraryImmediately: (nextLibrary: LibraryState) => Promise<boolean>
  requestPreviewFont: (font: FontItem) => void
  loadCacheStats: () => Promise<void> | void
  refreshDatabaseDerivedState: () => void
  setSelectedFontIds: Dispatch<SetStateAction<string[]>>
  setNativePreviewImages: Dispatch<SetStateAction<Record<string, string>>>
  setFailedPreviewFontIds: Dispatch<SetStateAction<Record<string, true>>>
  setSelectedFontId: Dispatch<SetStateAction<string>>
  setDetailVisible: Dispatch<SetStateAction<boolean>>
  setNativeDetailImage: Dispatch<SetStateAction<string>>
  setStatus: Dispatch<SetStateAction<string>>
}): void {
  const argsRef = useRef(args)
  argsRef.current = args

  useEffect(() => {
    if (typeof args.hfm.onFontIndexChanged !== 'function') return

    const dispose = args.hfm.onFontIndexChanged((payload: FontIndexChangePayload) => {
      const current = argsRef.current
      const scrollSnapshot = current.captureFontScrollSnapshot()
      const result = applyFontIndexChangeToLibrary(current.getCurrentLibrary(), payload)
      const removedIds = result.removedIds
      const upsertedFonts = result.upsertedFonts
      current.commitLibraryUpdate(result.library)

      const earlyVisibleOnly = payload.source === 'scan-stream' && upsertedFonts.length > 0 && upsertedFonts.every((font) => font.__earlyVisible)
      current.restoreFontScrollSnapshot(scrollSnapshot)

      if (!earlyVisibleOnly || removedIds.length > 0) {
        cleanupRemovedIndexedFontsFromRendererState({
          removedIds,
          selectedFontId: current.selectedFontId,
          previewQueue: current.previewQueue,
          autoPreviewCacheQueue: current.autoPreviewCacheQueue,
          queuedPreviewFontIds: current.queuedPreviewFontIds,
          queuedAutoPreviewCacheIds: current.queuedAutoPreviewCacheIds,
          loadingFonts: current.loadingFonts,
          setSelectedFontIds: current.setSelectedFontIds,
          setNativePreviewImages: current.setNativePreviewImages,
          setFailedPreviewFontIds: current.setFailedPreviewFontIds,
          setSelectedFontId: current.setSelectedFontId,
          setDetailVisible: current.setDetailVisible,
          setNativeDetailImage: current.setNativeDetailImage
        })
      }

      if (payload.source !== 'scan-stream') {
        current.refreshDatabaseDerivedState()
        for (const font of upsertedFonts) {
          if (!font.__earlyVisible) current.requestPreviewFont(font)
        }
      }

      void (async () => {
        if (!earlyVisibleOnly && !await current.saveLibraryImmediately(result.library)) return
        if (payload.source !== 'scan-stream') await current.loadCacheStats()
      })()

      current.setStatus(payload.source === 'scan-stream'
        ? `后台索引已先显示 ${upsertedFonts.length} 个已扫描字体，剩余继续扫描中……`
        : fontIndexChangeStatusText({ upserted: upsertedFonts.length, removed: removedIds.length, errors: payload.errors?.length || 0 }))
    })

    return () => dispose()
  }, [args.hfm])
}
