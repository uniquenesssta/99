import { useEffect, useRef } from 'react'
import type { RendererClosingLifecycleRuntime } from '../rendererClosingLifecycleRuntime'

export function useAppFlushOnUnloadRuntime(args: {
  hfm: Window['hfm']
  clearDatabaseRefreshTimer: () => void
  clearFontListScrollIdleTimer: () => void
  clearQueuedFontWriteTimer: () => void
  flushFontWriteQueue: (reason: string) => Promise<boolean> | boolean | void
  flushLibraryPersistence: () => Promise<boolean>
  closingLifecycle: RendererClosingLifecycleRuntime
}): void {
  const argsRef = useRef(args)
  argsRef.current = args

  useEffect(() => {
    const clearPendingTimers = (): void => {
      const current = argsRef.current
      current.clearQueuedFontWriteTimer()
      current.clearDatabaseRefreshTimer()
      current.clearFontListScrollIdleTimer()
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
      argsRef.current.closingLifecycle.beginClosing()
      void flushApplicationState('beforeunload')
    }

    const disposeCloseFlush = typeof args.hfm.onWindowFlushBeforeClose === 'function'
      ? args.hfm.onWindowFlushBeforeClose((payload) => {
          argsRef.current.closingLifecycle.beginClosing()
          void flushApplicationState('window-close').then((saved) => (
            argsRef.current.hfm.completeWindowCloseFlush(payload.requestId, saved)
          )).catch(() => (
            argsRef.current.hfm.completeWindowCloseFlush(payload.requestId, false)
          ))
        })
      : null

    const disposeCloseCancelled = typeof args.hfm.onWindowCloseCancelled === 'function'
      ? args.hfm.onWindowCloseCancelled(() => {
          argsRef.current.closingLifecycle.resume()
        })
      : null

    window.addEventListener('beforeunload', flushBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', flushBeforeUnload)
      disposeCloseFlush?.()
      disposeCloseCancelled?.()
      clearPendingTimers()
      void flushApplicationState('unmount')
    }
  }, [args.hfm])
}
