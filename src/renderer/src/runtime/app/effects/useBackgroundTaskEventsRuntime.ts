import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

function isSchedulerStoppingEvent(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false
  const event = payload as { eventType?: unknown; status?: unknown }
  if (event.eventType !== 'scheduler' || !event.status || typeof event.status !== 'object') return false
  return (event.status as { stopping?: unknown }).stopping === true
}

export function useBackgroundTaskEventsRuntime(args: {
  enabled: boolean
  hfm: Window['hfm']
  setLatestBackgroundTaskEvent: Dispatch<SetStateAction<unknown>>
  appendDeveloperStatus: (source: string, message: string, payload?: unknown) => void
  refreshDeveloperStatusDetails: () => Promise<void>
}): void {
  const { enabled, hfm, setLatestBackgroundTaskEvent, appendDeveloperStatus, refreshDeveloperStatusDetails } = args

  useEffect(() => {
    if (!enabled || typeof hfm.onBackgroundTasksChanged !== 'function') return

    void refreshDeveloperStatusDetails()
    const dispose = hfm.onBackgroundTasksChanged((payload: unknown) => {
      setLatestBackgroundTaskEvent(payload)
      appendDeveloperStatus('background-task', '后台任务状态变化', payload)
      // Scheduler stop is the shutdown freeze signal. Do not start a new
      // developer diagnostics sweep after the main process has closed IPC admission.
      if (isSchedulerStoppingEvent(payload)) return
      void refreshDeveloperStatusDetails()
    })

    return () => dispose()
  }, [])
}
