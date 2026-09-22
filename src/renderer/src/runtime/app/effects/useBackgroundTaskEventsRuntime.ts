import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { RendererClosingLifecycleRuntime } from '../rendererClosingLifecycleRuntime'

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
  closingLifecycle: RendererClosingLifecycleRuntime
}): void {
  const { enabled, hfm, setLatestBackgroundTaskEvent, appendDeveloperStatus, refreshDeveloperStatusDetails, closingLifecycle } = args

  useEffect(() => {
    if (!enabled || typeof hfm.onBackgroundTasksChanged !== 'function') return

    if (!closingLifecycle.isClosing()) void refreshDeveloperStatusDetails()
    const dispose = hfm.onBackgroundTasksChanged((payload: unknown) => {
      if (closingLifecycle.isClosing()) return
      setLatestBackgroundTaskEvent(payload)
      appendDeveloperStatus('background-task', '后台任务状态变化', payload)
      // Scheduler stopping is only a scheduler-domain fact. Explicit renderer
      // closing admission above owns shutdown suppression.
      if (isSchedulerStoppingEvent(payload)) return
      void refreshDeveloperStatusDetails()
    })

    return () => dispose()
  }, [])
}
