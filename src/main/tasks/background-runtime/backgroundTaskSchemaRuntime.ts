import type { TaskRuntimeOptions } from './backgroundTaskTypes'

export function initializeTasksDb(options: TaskRuntimeOptions, db: any): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      task_key TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      run_at TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      progress REAL NOT NULL DEFAULT 0,
      message TEXT,
      locked_by TEXT,
      heartbeat_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status_run ON tasks(status, run_at, priority);
    CREATE INDEX IF NOT EXISTS idx_tasks_type_status ON tasks(type, status);
    CREATE INDEX IF NOT EXISTS idx_tasks_locked ON tasks(locked_by, heartbeat_at);
    CREATE TABLE IF NOT EXISTS task_errors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_key TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      message TEXT NOT NULL,
      stack TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_errors_task ON task_errors(task_key, created_at);
  `)
  options.ensureSqliteColumn(db, 'tasks', 'type', "TEXT NOT NULL DEFAULT 'generic'")
  options.ensureSqliteColumn(db, 'tasks', 'payload_json', "TEXT NOT NULL DEFAULT '{}'")
  options.ensureSqliteColumn(db, 'tasks', 'attempts', 'INTEGER NOT NULL DEFAULT 0')
  options.ensureSqliteColumn(db, 'tasks', 'max_attempts', 'INTEGER NOT NULL DEFAULT 3')
  options.ensureSqliteColumn(db, 'tasks', 'locked_by', 'TEXT')
  options.ensureSqliteColumn(db, 'tasks', 'heartbeat_at', 'TEXT')
  options.ensureSqliteColumn(db, 'tasks', 'completed_at', 'TEXT')
  options.ensureSqliteColumn(db, 'task_errors', 'attempt', 'INTEGER NOT NULL DEFAULT 0')
  options.ensureSqliteColumn(db, 'task_errors', 'stack', 'TEXT')
  options.setSqliteMeta(db, 'schemaVersion', String(options.taskSqliteSchemaVersion))
  options.setSqliteMeta(db, 'updatedAt', new Date().toISOString())
}

export function resetStaleRunningTasks(options: TaskRuntimeOptions, db: any): void {
  const staleBefore = new Date(Date.now() - options.taskLockStaleMs).toISOString()
  const now = new Date().toISOString()
  const safeTypes = Array.from(options.safeStartupTaskTypes)
  const safePlaceholders = safeTypes.map(() => '?').join(', ') || "''"

  const reset = db.prepare(`
    UPDATE tasks
    SET status = 'pending', locked_by = NULL, heartbeat_at = NULL, message = '上次运行中断，已恢复为待执行', updated_at = ?
    WHERE status = 'running'
      AND (heartbeat_at IS NULL OR heartbeat_at < ?)
      AND type IN (${safePlaceholders})
  `).run(now, staleBefore, ...safeTypes)
  if (reset.changes) options.appendStartupLog(`tasks stale running reset: ${reset.changes}`)

  if (!options.recoverScanTasksOnStartup) {
    const skipped = db.prepare(`
      UPDATE tasks
      SET status = 'skipped', locked_by = NULL, heartbeat_at = NULL, progress = 1, message = 'v2 启动策略：scanRoot 不在启动时自动恢复，请手动更新索引。', updated_at = ?, completed_at = ?
      WHERE status IN ('pending', 'running', 'failed') AND type = 'scanRoot'
    `).run(now, now)
    if (skipped.changes) options.appendStartupLog(`startup scanRoot tasks skipped by policy: ${skipped.changes}`)
  }

  const skippedInstall = db.prepare(`
    UPDATE tasks
    SET status = 'skipped', locked_by = NULL, heartbeat_at = NULL, progress = 1, message = 'v1.0.2 已移除安装状态懒检查；请手动刷新安装状态。', updated_at = ?, completed_at = ?
    WHERE status IN ('pending', 'running', 'failed') AND type = 'checkInstallStatus'
  `).run(now, now)
  if (skippedInstall.changes) options.appendStartupLog(`startup checkInstallStatus tasks skipped by policy: ${skippedInstall.changes}`)
}
