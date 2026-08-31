import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'

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
      void refreshDeveloperStatusDetails()
    })

    return () => dispose()
  }, [])
}
