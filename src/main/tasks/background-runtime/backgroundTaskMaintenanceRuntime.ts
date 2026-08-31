import type { TaskMaintenanceReport,TaskRuntimeOptions } from './backgroundTaskTypes'
import { isoBefore } from './backgroundTaskUtils'

export function createBackgroundTaskMaintenanceRuntime(options: TaskRuntimeOptions, openTasksDb: () => Promise<any>): {
  runTaskMaintenance: () => Promise<TaskMaintenanceReport>
} {
  const runTaskMaintenance = async (): Promise<TaskMaintenanceReport> => {
    const db = await openTasksDb()
    const staleBefore = new Date(Date.now() - options.taskLockStaleMs).toISOString()
    const safeTypes = Array.from(options.safeStartupTaskTypes)
    const placeholders = safeTypes.map(() => '?').join(', ') || "''"
    const reset = db.prepare(`
      UPDATE tasks
      SET status = 'pending', locked_by = NULL, heartbeat_at = NULL, message = '维护时检测到任务中断，已恢复为待执行', updated_at = ?
      WHERE status = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?) AND type IN (${placeholders})
    `).run(new Date().toISOString(), staleBefore, ...safeTypes)

    const removedCompleted = db.prepare(`
      DELETE FROM tasks
      WHERE status IN ('done', 'skipped')
        AND COALESCE(completed_at, updated_at) < ?
    `).run(isoBefore(options.completedTaskRetentionMs))

    const removedFailed = db.prepare(`
      DELETE FROM tasks
      WHERE status = 'failed'
        AND updated_at < ?
    `).run(isoBefore(options.failedTaskRetentionMs))

    const removedOldErrors = db.prepare(`DELETE FROM task_errors WHERE created_at < ?`).run(isoBefore(options.taskErrorRetentionMs))
    const removedOrphanErrors = db.prepare(`
      DELETE FROM task_errors
      WHERE task_key NOT IN (SELECT task_key FROM tasks)
    `).run()

    return {
      resetRunning: Number(reset.changes || 0),
      removedCompleted: Number(removedCompleted.changes || 0),
      removedFailed: Number(removedFailed.changes || 0),
      removedErrors: Number(removedOldErrors.changes || 0) + Number(removedOrphanErrors.changes || 0)
    }
  }

  return { runTaskMaintenance }
}
