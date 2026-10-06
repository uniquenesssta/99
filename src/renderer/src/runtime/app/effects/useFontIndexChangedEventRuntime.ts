import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { FontIndexChangePayload, LibraryState } from '@shared/types'
import { applyFontIndexChangeToLibrary } from '../../../appRuntime'
import { normalizeFolderPathForCompare } from '../../../library-normalize/libraryNormalizeBase'
import { fontIndexChangeStatusText } from '../../../fontIndexEventRuntime'

export function useFontIndexChangedEventRuntime(args: {
  hfm: Window['hfm']
  cleanupRemovedFontState: (removedFontIds: string[]) => void
  captureFontScrollSnapshot: () => unknown
  restoreFontScrollSnapshot: (snapshot: any) => void
  getCurrentLibrary: () => LibraryState
  commitLibraryUpdate: (update: SetStateAction<LibraryState>) => LibraryState
  saveLibraryImmediately: (nextLibrary: LibraryState) => Promise<boolean>
  loadCacheStats: () => Promise<void> | void
  refreshDatabaseDerivedState: () => void
  setStatus: Dispatch<SetStateAction<string>>
}): void {
  const argsRef = useRef(args)
  argsRef.current = args

  useEffect(() => {
    if (typeof args.hfm.onFontIndexChanged !== 'function') return

    let disposed = false
    let scheduled = false
    let saveInFlight = false
    let pendingSave = false
    let pendingStats = false
    let pendingRefresh = false

    const flush = async (): Promise<void> => {
      scheduled = false
      if (disposed) return
      const current = argsRef.current
      if (pendingRefresh) {
        pendingRefresh = false
        current.refreshDatabaseDerivedState()
      }
      if (saveInFlight) return
      if (!pendingSave) {
        if (pendingStats) { pendingStats = false; await current.loadCacheStats() }
        return
      }
      saveInFlight = true
      try {
        while (!disposed && pendingSave) {
          pendingSave = false
          const statsRequested = pendingStats
          pendingStats = false
          // Autosave owns write ordering and persistence retries. Always hand it
          // the latest committed shell, never an earlier event's snapshot.
          if (!await argsRef.current.saveLibraryImmediately(argsRef.current.getCurrentLibrary())) continue
          if (!disposed && statsRequested && !pendingSave) await argsRef.current.loadCacheStats()
          else if (statsRequested && pendingSave) pendingStats = true
        }
      } finally {
        saveInFlight = false
      }
    }
    const scheduleFlush = (): void => {
      if (scheduled || disposed) return
      scheduled = true
      void Promise.resolve().then(flush)
    }

    const dispose = args.hfm.onFontIndexChanged((payload: FontIndexChangePayload) => {
      const current = argsRef.current
      const hasRows = !!(payload.upserts.length || payload.deletes.length)
      if (!hasRows) {
        if (payload.errors?.length) current.setStatus(fontIndexChangeStatusText({ upserted: 0, removed: 0, errors: payload.errors.length }))
        return
      }
      const previous = current.getCurrentLibrary()
      if (!(previous.folders || []).some(folder => normalizeFolderPathForCompare(folder) === normalizeFolderPathForCompare(payload.folder))) return
      const metadataOnly = payload.source === 'shared-metadata' && !!payload.metadataFields?.length && !payload.deletes.length
      const result = applyFontIndexChangeToLibrary(previous, payload)
      if (result.library === previous) {
        // The hydration window may not contain a deleted row. Main authority still
        // changed totals/pages, and recovery replay may repair a merged snapshot.
        if (payload.source !== 'scan-stream' && !metadataOnly) {
          pendingRefresh = true
          pendingStats = true
          scheduleFlush()
        }
        if (payload.errors?.length) current.setStatus(fontIndexChangeStatusText({ upserted: 0, removed: 0, errors: payload.errors.length }))
        return
      }
      const scrollSnapshot = current.captureFontScrollSnapshot()
      const removedIds = result.removedIds
      const upsertedFonts = result.upsertedFonts
      current.commitLibraryUpdate(result.library)

      const earlyVisibleOnly = payload.source === 'scan-stream' && upsertedFonts.length > 0 && upsertedFonts.every((font) => font.__earlyVisible)
      current.restoreFontScrollSnapshot(scrollSnapshot)
      if (removedIds.length) current.cleanupRemovedFontState(removedIds)

      // Visible cards are the only foreground preview demand owners. Index rows
      // never become invisible callers that keep obsolete preview work alive.
      if (!metadataOnly) {
        pendingRefresh ||= payload.source !== 'scan-stream'
        pendingSave ||= !earlyVisibleOnly
        pendingStats ||= payload.source !== 'scan-stream'
        scheduleFlush()
      }
      current.setStatus(payload.source === 'scan-stream'
        ? `后台索引已先显示 ${upsertedFonts.length} 个已扫描字体，剩余继续扫描中……`
        : fontIndexChangeStatusText({ upserted: upsertedFonts.length, removed: removedIds.length, errors: payload.errors?.length || 0 }))
    })

    return () => { disposed = true; dispose() }
  }, [args.hfm])
}
