import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import { createBackgroundTaskMaintenanceRuntime } from './background-runtime/backgroundTaskMaintenanceRuntime'
import { initializeTasksDb,resetStaleRunningTasks } from './background-runtime/backgroundTaskSchemaRuntime'
import { createBackgroundTaskStoreRuntime } from './background-runtime/backgroundTaskStoreRuntime'
import type { BackgroundTaskRuntimeApi,TaskRuntimeOptions } from './background-runtime/backgroundTaskTypes'
import { createLegacyTaskMigrator } from './background-runtime/legacyTaskMigrationRuntime'

export type {
BackgroundTaskRecord,BackgroundTaskStatus,BackgroundTaskSummary,
TaskMaintenanceReport,
TaskRuntimeOptions
} from './background-runtime/backgroundTaskTypes'
export { normalizeTaskType,parseBackgroundTaskPayload,taskRecordToSummary } from './background-runtime/backgroundTaskUtils'

export function createBackgroundTaskRuntime(options: TaskRuntimeOptions): BackgroundTaskRuntimeApi {
  let tasksDb: any | null = null
  let tasksDbOpening: Promise<any> | null = null
  const migrateLegacyTasksFromLibraryDb = createLegacyTaskMigrator(options)

  const openTasksDb = async (): Promise<any> => {
    if (tasksDb) return tasksDb
    if (tasksDbOpening) return tasksDbOpening

    tasksDbOpening = (async () => {
      await fsp.mkdir(dirname(options.tasksSqlitePath()), { recursive: true })
      const db = await options.openRecoverableApplicationSqliteDb(options.tasksSqlitePath(), 'tasks')
      try {
        initializeTasksDb(options, db)
        resetStaleRunningTasks(options, db)
        migrateLegacyTasksFromLibraryDb(db)
        tasksDb = db
        return db
      } catch (error) {
        options.closeSqliteDb(db)
        throw error
      }
    })()

    try {
      return await tasksDbOpening
    } finally {
      tasksDbOpening = null
    }
  }

  const closeTasksDb = (): void => {
    options.closeSqliteDb(tasksDb)
    tasksDb = null
    tasksDbOpening = null
  }

  const getOpenTasksDb = (): any | null => tasksDb

  const checkpointTasksDb = (): void => {
    if (!tasksDb) return
    try {
      tasksDb.exec('PRAGMA wal_checkpoint(PASSIVE);')
    } catch {
      // ignore checkpoint errors; quick_check will still report actual corruption
    }
  }

  return {
    openTasksDb,
    closeTasksDb,
    getOpenTasksDb,
    checkpointTasksDb,
    ...createBackgroundTaskStoreRuntime({ openTasksDb }),
    ...createBackgroundTaskMaintenanceRuntime(options, openTasksDb)
  }
}
