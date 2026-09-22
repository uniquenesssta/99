import type { DeveloperStatusEntry } from './appTypes'

function isApplicationClosingIpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('软件正在退出，此操作未继续执行。')
}

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
  isClosing?: () => boolean
}): Promise<void> {
  const shouldStop = (): boolean => !options.enabled || options.isClosing?.() === true
  if (shouldStop()) return

  try {
    if (typeof options.hfm.getCacheArchitecture === 'function') {
      const value = await options.hfm.getCacheArchitecture()
      if (shouldStop()) return
      options.setArchitecture(value)
    }
  } catch (error) {
    if (isApplicationClosingIpcError(error)) return
    if (shouldStop()) return
    options.appendStatus('developer', `读取缓存架构失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (shouldStop()) return
  try {
    if (typeof options.hfm.getBackgroundTaskSchedulerStatus === 'function') {
      const value = await options.hfm.getBackgroundTaskSchedulerStatus()
      if (shouldStop()) return
      options.setSchedulerStatus(value)
    }
  } catch (error) {
    if (isApplicationClosingIpcError(error)) return
    if (shouldStop()) return
    options.appendStatus('developer', `读取任务调度器失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (shouldStop()) return
  try {
    if (typeof options.hfm.getMigrationDiagnostics === 'function') {
      const value = await options.hfm.getMigrationDiagnostics()
      if (shouldStop()) return
      options.setMigrationDiagnostics(value)
    }
  } catch (error) {
    if (isApplicationClosingIpcError(error)) return
    if (shouldStop()) return
    options.appendStatus('developer', `读取迁移诊断失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (shouldStop()) return
  try {
    if (typeof options.hfm.getSharedMetadataDiagnostics === 'function') {
      const value = await options.hfm.getSharedMetadataDiagnostics({ includeRepairDryRun: true })
      if (shouldStop()) return
      options.setSharedMetadataDiagnostics(value)
    }
  } catch (error) {
    if (isApplicationClosingIpcError(error)) return
    if (shouldStop()) return
    options.appendStatus('developer', `读取共享元数据诊断失败：${error instanceof Error ? error.message : String(error)}`)
  }

  if (shouldStop()) return
  try {
    if (typeof options.hfm.listBackgroundTasks === 'function') {
      const tasks = await options.hfm.listBackgroundTasks(undefined, 80)
      if (shouldStop()) return
      options.setTasks(Array.isArray(tasks) ? tasks : [])
    }
  } catch (error) {
    if (isApplicationClosingIpcError(error)) return
    if (shouldStop()) return
    options.appendStatus('developer', `读取后台任务失败：${error instanceof Error ? error.message : String(error)}`)
  }
}
