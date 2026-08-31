import type { DeveloperStatusEntry } from './appTypes'

export function appendDeveloperStatusEntry(
  prev: DeveloperStatusEntry[],
  source: string,
  message: string,
  payload?: unknown,
  limit = 200
): DeveloperStatusEntry[] {
  return [{ id: Date.now() + Math.random(), at: new Date().toLocaleString(), source, message, payload }, ...prev].slice(0, limit)
}

export async function refreshDeveloperStatusDetailsRuntime(options: {
  enabled: boolean
  hfm: Window['hfm']
  setArchitecture: (value: unknown) => void
  setSchedulerStatus: (value: unknown) => void
  setMigrationDiagnostics: (value: unknown) => void
  setSharedMetadataDiagnostics: (value: unknown) => void
  setTasks: (value: unknown[]) => void
  appendStatus: (source: string, message: string) => void
}): Promise<void> {
  if (!options.enabled) return

  try {
    if (typeof options.hfm.getCacheArchitecture === 'function') {
      options.setArchitecture(await options.hfm.getCacheArchitecture())
    }
  } catch (error) {
    options.appendStatus('developer', `读取缓存架构失败：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    if (typeof options.hfm.getBackgroundTaskSchedulerStatus === 'function') {
      options.setSchedulerStatus(await options.hfm.getBackgroundTaskSchedulerStatus())
    }
  } catch (error) {
    options.appendStatus('developer', `读取任务调度器失败：${error instanceof Error ? error.message : String(error)}`)
  }


  try {
    if (typeof options.hfm.getMigrationDiagnostics === 'function') {
      options.setMigrationDiagnostics(await options.hfm.getMigrationDiagnostics())
    }
  } catch (error) {
    options.appendStatus('developer', `读取迁移诊断失败：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    if (typeof options.hfm.getSharedMetadataDiagnostics === 'function') {
      options.setSharedMetadataDiagnostics(await options.hfm.getSharedMetadataDiagnostics({ includeRepairDryRun: true }))
    }
  } catch (error) {
    options.appendStatus('developer', `读取共享元数据诊断失败：${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    if (typeof options.hfm.listBackgroundTasks === 'function') {
      const tasks = await options.hfm.listBackgroundTasks(undefined, 80)
      options.setTasks(Array.isArray(tasks) ? tasks : [])
    }
  } catch (error) {
    options.appendStatus('developer', `读取后台任务失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
