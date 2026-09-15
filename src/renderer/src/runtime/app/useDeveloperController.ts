import type { FontIndexProgressPayload } from '@shared/types'
import { useRef,useState } from 'react'
import type { DeveloperStatusEntry } from '../../appRuntime'
import { appendDeveloperStatusEntry,refreshDeveloperStatusDetailsRuntime } from '../../rendererDeveloperStatusRuntime'
import { useBackgroundTaskEventsRuntime } from './effects/useBackgroundTaskEventsRuntime'
import { useRendererDeveloperStatusLogRuntime } from './effects/useRendererDeveloperStatusLogRuntime'

export function useDeveloperController(options: {
  enabled: boolean
  hfm: Window['hfm']
  status: string
}) {
  const [developerStatusLog, setDeveloperStatusLog] = useState<DeveloperStatusEntry[]>([])
  const [latestIndexProgress, setLatestIndexProgress] = useState<FontIndexProgressPayload | null>(null)
  const [latestBackgroundTaskEvent, setLatestBackgroundTaskEvent] = useState<unknown>(null)
  const [developerArchitecture, setDeveloperArchitecture] = useState<unknown>(null)
  const [developerSchedulerStatus, setDeveloperSchedulerStatus] = useState<unknown>(null)
  const [developerMigrationDiagnostics, setDeveloperMigrationDiagnostics] = useState<unknown>(null)
  const [developerSharedMetadataDiagnostics, setDeveloperSharedMetadataDiagnostics] = useState<unknown>(null)
  const [developerTasks, setDeveloperTasks] = useState<unknown[]>([])
  const developerStatusRefreshInFlightRef = useRef<Promise<void> | null>(null)

  function appendDeveloperStatus(source: string, message: string, payload?: unknown): void {
    if (!options.enabled) return
    setDeveloperStatusLog((prev) => appendDeveloperStatusEntry(prev, source, message, payload))
  }

  function refreshDeveloperStatusDetails(): Promise<void> {
    if (!options.enabled) return Promise.resolve()
    if (developerStatusRefreshInFlightRef.current) return developerStatusRefreshInFlightRef.current

    const task = refreshDeveloperStatusDetailsRuntime({
      enabled: options.enabled,
      hfm: options.hfm,
      setArchitecture: setDeveloperArchitecture,
      setSchedulerStatus: setDeveloperSchedulerStatus,
      setMigrationDiagnostics: setDeveloperMigrationDiagnostics,
      setSharedMetadataDiagnostics: setDeveloperSharedMetadataDiagnostics,
      setTasks: setDeveloperTasks,
      appendStatus: appendDeveloperStatus
    }).finally(() => {
      if (developerStatusRefreshInFlightRef.current === task) {
        developerStatusRefreshInFlightRef.current = null
      }
    })

    developerStatusRefreshInFlightRef.current = task
    return task
  }

  useRendererDeveloperStatusLogRuntime(options.status, appendDeveloperStatus)
  useBackgroundTaskEventsRuntime({
    enabled: options.enabled,
    hfm: options.hfm,
    setLatestBackgroundTaskEvent,
    appendDeveloperStatus,
    refreshDeveloperStatusDetails
  })

  return {
    developerStatusLog,
    setDeveloperStatusLog,
    latestIndexProgress,
    setLatestIndexProgress,
    latestBackgroundTaskEvent,
    developerArchitecture,
    developerSchedulerStatus,
    developerMigrationDiagnostics,
    developerSharedMetadataDiagnostics,
    setDeveloperSharedMetadataDiagnostics,
    developerTasks,
    appendDeveloperStatus,
    refreshDeveloperStatusDetails
  }
}
