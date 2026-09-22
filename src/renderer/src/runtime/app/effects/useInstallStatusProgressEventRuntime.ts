import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { InstallStatusProgressPayload } from '@shared/types'
import type { RendererClosingLifecycleRuntime } from '../rendererClosingLifecycleRuntime'

export function useInstallStatusProgressEventRuntime(args: {
  hfm: Window['hfm']
  knownInstallStatusIds: MutableRefObject<Set<string>>
  autoInstallStatusRefreshStartedRef: MutableRefObject<boolean>
  appendDeveloperStatus: (source: string, message: string, payload?: unknown) => void
  setStatus: Dispatch<SetStateAction<string>>
  refreshDatabaseDerivedState: () => void
  refreshDatabaseMetricsNow: () => void
  closingLifecycle: RendererClosingLifecycleRuntime
}): void {
  const {
    hfm,
    knownInstallStatusIds,
    autoInstallStatusRefreshStartedRef,
    appendDeveloperStatus,
    setStatus,
    refreshDatabaseDerivedState,
    refreshDatabaseMetricsNow,
    closingLifecycle
  } = args

  useEffect(() => {
    if (typeof hfm.onInstallStatusProgress !== 'function') {
      return
    }

    const pendingTimers = new Set<number>()
    const clearPendingTimers = (): void => {
      for (const timer of pendingTimers) window.clearTimeout(timer)
      pendingTimers.clear()
    }
    const schedule = (action: () => void, delayMs: number): void => {
      if (closingLifecycle.isClosing()) return
      const timer = window.setTimeout(() => {
        pendingTimers.delete(timer)
        if (!closingLifecycle.isClosing()) action()
      }, delayMs)
      pendingTimers.add(timer)
    }
    const disposeClosing = closingLifecycle.subscribe((closing) => {
      if (closing) clearPendingTimers()
    })

    const dispose = hfm.onInstallStatusProgress((payload: InstallStatusProgressPayload) => {
      if (closingLifecycle.isClosing()) return
      appendDeveloperStatus('install-status', payload.message, payload)
      setStatus(payload.message)
      if (payload.stage === 'done') {
        autoInstallStatusRefreshStartedRef.current = false
        knownInstallStatusIds.current.clear()
        refreshDatabaseDerivedState()
        schedule(refreshDatabaseMetricsNow, 80)
        schedule(() => {
          refreshDatabaseDerivedState()
          refreshDatabaseMetricsNow()
        }, 900)
      } else if (payload.stage === 'cancelled' || payload.stage === 'error') {
        autoInstallStatusRefreshStartedRef.current = false
      }
    })

    return () => {
      dispose()
      disposeClosing()
      clearPendingTimers()
    }
  }, [closingLifecycle])
}
