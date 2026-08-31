import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { InstallStatusProgressPayload } from '@shared/types'

export function useInstallStatusProgressEventRuntime(args: {
  hfm: Window['hfm']
  knownInstallStatusIds: MutableRefObject<Set<string>>
  autoInstallStatusRefreshStartedRef: MutableRefObject<boolean>
  appendDeveloperStatus: (source: string, message: string, payload?: unknown) => void
  setStatus: Dispatch<SetStateAction<string>>
  refreshDatabaseDerivedState: () => void
  refreshDatabaseMetricsNow: () => void
}): void {
  const {
    hfm,
    knownInstallStatusIds,
    autoInstallStatusRefreshStartedRef,
    appendDeveloperStatus,
    setStatus,
    refreshDatabaseDerivedState,
    refreshDatabaseMetricsNow
  } = args

  useEffect(() => {
    if (typeof hfm.onInstallStatusProgress !== 'function') {
      return
    }

    const dispose = hfm.onInstallStatusProgress((payload: InstallStatusProgressPayload) => {
      appendDeveloperStatus('install-status', payload.message, payload)
      setStatus(payload.message)
      if (payload.stage === 'done') {
        autoInstallStatusRefreshStartedRef.current = false
        knownInstallStatusIds.current.clear()
        refreshDatabaseDerivedState()
        window.setTimeout(refreshDatabaseMetricsNow, 80)
        window.setTimeout(() => {
          refreshDatabaseDerivedState()
          refreshDatabaseMetricsNow()
        }, 900)
      } else if (payload.stage === 'cancelled' || payload.stage === 'error') {
        autoInstallStatusRefreshStartedRef.current = false
      }
    })

    return () => dispose()
  }, [])
}
