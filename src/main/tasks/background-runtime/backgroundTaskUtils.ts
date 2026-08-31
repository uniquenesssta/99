import type { BackgroundTaskRecord,BackgroundTaskSummary } from './backgroundTaskTypes'

export function isoBefore(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

export function safeTaskPayloadJson(data: unknown): string {
  try {
    return JSON.stringify(data || {})
  } catch {
    return '{}'
  }
}

export function normalizeTaskType(name: string): string {
  if (name === 'preview_cache') return 'generatePreview'
  if (name === 'install_status') return 'checkInstallStatus'
  if (name === 'scan_root' || name === 'scanRoot') return 'scanRoot'
  return name || 'generic'
}

export function taskRecordToSummary(row: BackgroundTaskRecord): BackgroundTaskSummary {
  return {
    taskKey: row.task_key,
    type: row.type || normalizeTaskType(row.name),
    name: row.name,
    status: row.status,
    priority: Number(row.priority || 0),
    runAt: row.run_at,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    progress: Number(row.progress || 0),
    message: row.message || null,
    updatedAt: row.updated_at,
    completedAt: row.completed_at || null
  }
}

export function parseBackgroundTaskPayload<T extends Record<string, unknown> = Record<string, unknown>>(task: BackgroundTaskRecord): T {
  try {
    const parsed = JSON.parse(task.payload_json || '{}')
    return parsed && typeof parsed === 'object' ? parsed as T : {} as T
  } catch {
    return {} as T
  }
}
