import os from 'node:os'
import type { BackgroundTaskRecord,BackgroundTaskStatus,BackgroundTaskSummary } from './backgroundTaskTypes'
import { normalizeTaskType,safeTaskPayloadJson,taskRecordToSummary } from './backgroundTaskUtils'

type StoreDeps = {
  openTasksDb: () => Promise<any>
}

export function createBackgroundTaskStoreRuntime(deps: StoreDeps): {
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
} {
  const upsertBackgroundTask = async (
    taskKey: string,
    name: string,
    priority: number,
    data: unknown,
    status: BackgroundTaskStatus = 'pending',
    message?: string,
    taskOptions: { maxAttempts?: number; runAt?: Date | string } = {}
  ): Promise<void> => {
    const db = await deps.openTasksDb()
    const now = new Date().toISOString()
    const runAt = taskOptions.runAt instanceof Date ? taskOptions.runAt.toISOString() : taskOptions.runAt || now
    const maxAttempts = Math.max(1, Math.min(20, Number(taskOptions.maxAttempts || 3)))
    db.prepare(`
      INSERT INTO tasks (
        task_key, type, name, status, priority, run_at, payload_json, attempts, max_attempts,
        progress, message, locked_by, heartbeat_at, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, ?, ?, ?)
      ON CONFLICT(task_key) DO UPDATE SET
        type = excluded.type,
        name = excluded.name,
        priority = excluded.priority,
        run_at = excluded.run_at,
        payload_json = excluded.payload_json,
        status = CASE WHEN tasks.status = 'running' AND excluded.status = 'pending' THEN tasks.status ELSE excluded.status END,
        max_attempts = excluded.max_attempts,
        progress = excluded.progress,
        message = excluded.message,
        locked_by = CASE WHEN excluded.status = 'running' THEN tasks.locked_by ELSE NULL END,
        heartbeat_at = CASE WHEN excluded.status = 'running' THEN tasks.heartbeat_at ELSE NULL END,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `).run(
      taskKey,
      normalizeTaskType(name),
      name,
      status,
      priority,
      runAt,
      safeTaskPayloadJson(data),
      maxAttempts,
      status === 'done' || status === 'skipped' ? 1 : 0,
      message || null,
      now,
      now,
      status === 'done' || status === 'skipped' ? now : null
    )
  }

  const startBackgroundTask = async (taskKey: string, workerId = `${os.hostname()}:${process.pid}`): Promise<BackgroundTaskRecord | null> => {
    const db = await deps.openTasksDb()
    const now = new Date().toISOString()
    const tx = db.transaction(() => {
      const row = db.prepare(`
        SELECT * FROM tasks
        WHERE task_key = ? AND status IN ('pending', 'failed') AND attempts < max_attempts AND run_at <= ?
      `).get(taskKey, now) as BackgroundTaskRecord | undefined
      if (!row) return null
      db.prepare(`
        UPDATE tasks
        SET status = 'running', attempts = attempts + 1, locked_by = ?, heartbeat_at = ?, updated_at = ?
        WHERE task_key = ?
      `).run(workerId, now, now, taskKey)
      return { ...row, status: 'running' as BackgroundTaskStatus, locked_by: workerId, heartbeat_at: now, attempts: Number(row.attempts || 0) + 1 }
    })
    return tx()
  }

  const heartbeatBackgroundTask = async (taskKey: string, progress?: number, message?: string): Promise<void> => {
    const db = await deps.openTasksDb()
    db.prepare(`
      UPDATE tasks
      SET heartbeat_at = ?, progress = COALESCE(?, progress), message = COALESCE(?, message), updated_at = ?
      WHERE task_key = ? AND status = 'running'
    `).run(new Date().toISOString(), typeof progress === 'number' ? progress : null, message || null, new Date().toISOString(), taskKey)
  }

  const completeBackgroundTask = async (taskKey: string, message?: string): Promise<void> => {
    const db = await deps.openTasksDb()
    const now = new Date().toISOString()
    db.prepare(`
      UPDATE tasks
      SET status = 'done', progress = 1, message = ?, locked_by = NULL, heartbeat_at = NULL, updated_at = ?, completed_at = ?
      WHERE task_key = ?
    `).run(message || '完成', now, now, taskKey)
  }

  const skipBackgroundTask = async (taskKey: string, message?: string): Promise<void> => {
    const db = await deps.openTasksDb()
    const now = new Date().toISOString()
    db.prepare(`
      UPDATE tasks
      SET status = 'skipped', progress = 1, message = ?, locked_by = NULL, heartbeat_at = NULL, updated_at = ?, completed_at = ?
      WHERE task_key = ?
    `).run(message || '已跳过', now, now, taskKey)
  }

  const failBackgroundTask = async (taskKey: string, message: string, stack?: string): Promise<void> => {
    const db = await deps.openTasksDb()
    const now = new Date().toISOString()
    const row = db.prepare('SELECT attempts, max_attempts FROM tasks WHERE task_key = ?').get(taskKey) as { attempts?: number; max_attempts?: number } | undefined
    const attempts = Number(row?.attempts || 0)
    const maxAttempts = Number(row?.max_attempts || 3)
    const nextStatus: BackgroundTaskStatus = attempts >= maxAttempts ? 'failed' : 'pending'
    const nextRunAt = nextStatus === 'pending'
      ? new Date(Date.now() + Math.min(10 * 60 * 1000, Math.max(15 * 1000, attempts * 30 * 1000))).toISOString()
      : now
    db.prepare(`
      UPDATE tasks
      SET status = ?, run_at = ?, message = ?, locked_by = NULL, heartbeat_at = NULL, updated_at = ?
      WHERE task_key = ?
    `).run(nextStatus, nextRunAt, message, now, taskKey)
    db.prepare('INSERT INTO task_errors (task_key, attempt, message, stack, created_at) VALUES (?, ?, ?, ?, ?)').run(taskKey, attempts, message, stack || null, now)
  }

  const listBackgroundTasks = async (status?: BackgroundTaskStatus, limit = 200): Promise<BackgroundTaskRecord[]> => {
    const db = await deps.openTasksDb()
    const maxRows = Math.max(1, Math.min(1000, Math.floor(limit)))
    if (status) {
      return db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, run_at ASC LIMIT ?').all(status, maxRows) as BackgroundTaskRecord[]
    }
    return db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?').all(maxRows) as BackgroundTaskRecord[]
  }

  const listBackgroundTaskSummaries = async (status?: BackgroundTaskStatus, limit = 200): Promise<BackgroundTaskSummary[]> => {
    const rows = await listBackgroundTasks(status, limit)
    return rows.map(taskRecordToSummary)
  }

  const readDueBackgroundTasks = async (limit = 6, schedulerOptions: { recoverScanTasks?: boolean } = {}): Promise<BackgroundTaskRecord[]> => {
    const db = await deps.openTasksDb()
    const now = new Date().toISOString()
    const maxRows = Math.max(1, Math.min(100, Math.floor(limit)))
    const rows = db.prepare(`
      SELECT * FROM tasks
      WHERE status = 'pending' AND run_at <= ? AND attempts < max_attempts
      ORDER BY priority DESC, run_at ASC, created_at ASC
      LIMIT ?
    `).all(now, maxRows) as BackgroundTaskRecord[]
    return rows.filter((task) => {
      if (!schedulerOptions.recoverScanTasks && task.type === 'scanRoot') return false
      if (task.type === 'checkInstallStatus') return false
      return true
    })
  }

  return {
    upsertBackgroundTask,
    startBackgroundTask,
    heartbeatBackgroundTask,
    completeBackgroundTask,
    skipBackgroundTask,
    failBackgroundTask,
    listBackgroundTasks,
    listBackgroundTaskSummaries,
    readDueBackgroundTasks
  }
}
