import type { TaskRuntimeOptions } from './backgroundTaskTypes'
import { normalizeTaskType } from './backgroundTaskUtils'

export function createLegacyTaskMigrator(options: TaskRuntimeOptions): (taskDb: any) => void {
  let legacyTasksMigrated = false

  return (taskDb: any): void => {
    if (legacyTasksMigrated) return
    try {
      const libraryDb = options.getLibraryDb()
      if (!libraryDb) return
      legacyTasksMigrated = true
      const hasLegacyTasks = (libraryDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'").get() as unknown) !== undefined
      if (!hasLegacyTasks) return
      const already = taskDb.prepare('SELECT value FROM meta WHERE key = ?').get('legacyLibraryTasksMigrated') as { value?: string } | undefined
      if (already?.value === '1') return
      const rows = libraryDb.prepare(`
        SELECT task_key, name, priority, run_at, data_json, status, run_count, progress, message, created_at, updated_at
        FROM tasks
      `).all() as Array<{
        task_key: string
        name: string
        priority: number
        run_at: string
        data_json: string
        status: string
        run_count: number
        progress: number
        message?: string | null
        created_at: string
        updated_at: string
      }>
      const upsert = taskDb.prepare(`
        INSERT INTO tasks (
          task_key, type, name, status, priority, run_at, payload_json, attempts, max_attempts,
          progress, message, locked_by, heartbeat_at, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?, NULL, NULL, ?, ?, ?)
        ON CONFLICT(task_key) DO NOTHING
      `)
      const tx = taskDb.transaction(() => {
        for (const row of rows) {
          const status = row.status === 'done' || row.status === 'failed' || row.status === 'running' || row.status === 'pending' ? row.status : 'pending'
          upsert.run(
            row.task_key,
            normalizeTaskType(row.name),
            row.name || normalizeTaskType(row.name),
            status,
            Number(row.priority || 0),
            row.run_at || row.updated_at || new Date().toISOString(),
            row.data_json || '{}',
            Number(row.run_count || 0),
            Number(row.progress || 0),
            row.message || null,
            row.created_at || new Date().toISOString(),
            row.updated_at || new Date().toISOString(),
            status === 'done' ? row.updated_at || new Date().toISOString() : null
          )
        }
        options.setSqliteMeta(taskDb, 'legacyLibraryTasksMigrated', '1')
        options.setSqliteMeta(taskDb, 'legacyLibraryTasksMigratedAt', new Date().toISOString())
      })
      tx()
      if (rows.length) options.appendStartupLog(`legacy tasks migrated to tasks.sqlite: rows=${rows.length}`)
    } catch (error) {
      options.appendStartupLog(`legacy tasks migration skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
