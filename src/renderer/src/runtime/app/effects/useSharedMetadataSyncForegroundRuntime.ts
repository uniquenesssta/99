import { useEffect } from 'react'

function runWhenIdle(callback: () => void, timeout = 5000): number | null {
  const requestIdleCallback = (window as Window & {
    requestIdleCallback?: (handler: IdleRequestCallback, options?: IdleRequestOptions) => number
  }).requestIdleCallback

  if (typeof requestIdleCallback === 'function') {
    return requestIdleCallback(() => callback(), { timeout })
  }

  return window.setTimeout(callback, Math.min(timeout, 3000))
}

function cancelIdleRun(id: number | null): void {
  if (id === null) return
  const cancelIdleCallback = (window as Window & {
    cancelIdleCallback?: (handle: number) => void
  }).cancelIdleCallback
  if (typeof cancelIdleCallback === 'function') cancelIdleCallback(id)
  else window.clearTimeout(id)
}

export function useSharedMetadataSyncForegroundRuntime(args: {
  enabled: boolean
  libraryFoldersKey: string
  indexingActive: boolean
  checkSharedMetadataUpdates: (reason: string, minIntervalMs?: number) => Promise<void> | null
}): void {
  const { enabled, libraryFoldersKey, indexingActive, checkSharedMetadataUpdates } = args

  useEffect(() => {
    if (!enabled) return undefined

    let disposed = false
    let idleRunId: number | null = null
    const run = (reason: string, minIntervalMs = 30000): void => {
      if (disposed || indexingActive || document.visibilityState === 'hidden') return
      cancelIdleRun(idleRunId)
      idleRunId = runWhenIdle(() => {
        idleRunId = null
        if (disposed || indexingActive || document.visibilityState === 'hidden') return
        void checkSharedMetadataUpdates(reason, minIntervalMs)
      })
    }

    const startupTimer = window.setTimeout(() => run('startup-shared-metadata-sync', 30000), 8000)
    const intervalTimer = window.setInterval(() => run('foreground-shared-metadata-sync', 60000), 90000)
    const handleFocus = (): void => run('window-focus-shared-metadata-sync', 30000)
    const handleVisibility = (): void => {
      if (document.visibilityState === 'visible') run('visibility-shared-metadata-sync', 30000)
    }

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      disposed = true
      cancelIdleRun(idleRunId)
      window.clearTimeout(startupTimer)
      window.clearInterval(intervalTimer)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [libraryFoldersKey, indexingActive])
}
