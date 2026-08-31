export type BackgroundTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export type BackgroundTaskRecord = {
  task_key: string
  type: string
  name: string
  status: BackgroundTaskStatus
  priority: number
  run_at: string
  payload_json: string
  attempts: number
  max_attempts: number
  progress: number
  message?: string | null
  locked_by?: string | null
  heartbeat_at?: string | null
  created_at: string
  updated_at: string
  completed_at?: string | null
}

export type BackgroundTaskSummary = {
  taskKey: string
  type: string
  name: string
  status: BackgroundTaskStatus
  priority: number
  runAt: string
  attempts: number
  maxAttempts: number
  progress: number
  message?: string | null
  updatedAt: string
  completedAt?: string | null
}

export type TaskMaintenanceReport = {
  resetRunning: number
  removedCompleted: number
  removedFailed: number
  removedErrors: number
}

export type TaskRuntimeOptions = {
  tasksSqlitePath: () => string
  openRecoverableApplicationSqliteDb: (filePath: string, label: 'tasks') => Promise<any>
  closeSqliteDb: (db: any) => void
  ensureSqliteColumn: (db: any, table: string, column: string, declaration: string) => void
  setSqliteMeta: (db: any, key: string, value: string) => void
  getLibraryDb: () => any | null
  appendStartupLog: (message: string) => void
  taskSqliteSchemaVersion: number
  taskLockStaleMs: number
  safeStartupTaskTypes: Iterable<string>
  recoverScanTasksOnStartup: boolean
  completedTaskRetentionMs: number
  failedTaskRetentionMs: number
  taskErrorRetentionMs: number
}

export type BackgroundTaskRuntimeApi = {
  openTasksDb: () => Promise<any>
  closeTasksDb: () => void
  getOpenTasksDb: () => any | null
  checkpointTasksDb: () => void
  upsertBackgroundTask: (
    taskKey: string,
    name: string,
    priority: number,
    data: unknown,
    status?: BackgroundTaskStatus,
    message?: string,
    taskOptions?: { maxAttempts?: number; runAt?: Date | string }
  ) => Promise<void>
  startBackgroundTask: (taskKey: string, workerId?: string) => Promise<BackgroundTaskRecord | null>
  heartbeatBackgroundTask: (taskKey: string, progress?: number, message?: string) => Promise<void>
  completeBackgroundTask: (taskKey: string, message?: string) => Promise<void>
  skipBackgroundTask: (taskKey: string, message?: string) => Promise<void>
  failBackgroundTask: (taskKey: string, message: string, stack?: string) => Promise<void>
  listBackgroundTasks: (status?: BackgroundTaskStatus, limit?: number) => Promise<BackgroundTaskRecord[]>
  listBackgroundTaskSummaries: (status?: BackgroundTaskStatus, limit?: number) => Promise<BackgroundTaskSummary[]>
  readDueBackgroundTasks: (limit?: number, schedulerOptions?: { recoverScanTasks?: boolean }) => Promise<BackgroundTaskRecord[]>
  runTaskMaintenance: () => Promise<TaskMaintenanceReport>
}
