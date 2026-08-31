import { useEffect, useRef } from 'react'
import type { MutableRefObject } from 'react'

export function useAppFlushOnUnloadRuntime(args: {
  hfm: Window['hfm']
  databaseRefreshTimerRef: MutableRefObject<number | null>
  fontListScrollIdleTimerRef: MutableRefObject<number | null>
  clearQueuedFontWriteTimer: () => void
  flushFontWriteQueue: (reason: string) => Promise<boolean> | boolean | void
  flushLibraryPersistence: () => Promise<boolean>
}): void {
  const argsRef = useRef(args)
  argsRef.current = args

  useEffect(() => {
    const clearPendingTimers = (): void => {
      const current = argsRef.current
      current.clearQueuedFontWriteTimer()
      if (current.databaseRefreshTimerRef.current !== null) {
        window.clearTimeout(current.databaseRefreshTimerRef.current)
        current.databaseRefreshTimerRef.current = null
      }
      if (current.fontListScrollIdleTimerRef.current !== null) {
        window.clearTimeout(current.fontListScrollIdleTimerRef.current)
        current.fontListScrollIdleTimerRef.current = null
      }
    }

    const flushApplicationState = async (reason: string): Promise<boolean> => {
      const current = argsRef.current
      clearPendingTimers()
      let fontWritesSaved = true
      try {
        const result = await current.flushFontWriteQueue(reason)
        if (result === false) fontWritesSaved = false
      } catch {
        fontWritesSaved = false
      }
      const librarySaved = await current.flushLibraryPersistence().catch(() => false)
      return fontWritesSaved && librarySaved
    }

    const flushBeforeUnload = (): void => {
      void flushApplicationState('beforeunload')
    }

    const disposeCloseFlush = typeof args.hfm.onWindowFlushBeforeClose === 'function'
      ? args.hfm.onWindowFlushBeforeClose((payload) => {
          void flushApplicationState('window-close').then((saved) => (
            argsRef.current.hfm.completeWindowCloseFlush(payload.requestId, saved)
          )).catch(() => (
            argsRef.current.hfm.completeWindowCloseFlush(payload.requestId, false)
          ))
        })
      : null

    window.addEventListener('beforeunload', flushBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', flushBeforeUnload)
      disposeCloseFlush?.()
      clearPendingTimers()
      void flushApplicationState('unmount')
    }
  }, [args.hfm])
}
