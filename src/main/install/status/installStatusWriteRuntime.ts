import { rethrowSharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import type { FontItem,InstallCompareResult } from '../../../shared/types'
import type {
InstallStatusDbRuntime,
InstallStatusRuntimeDeps,
InstallStatusSaveWorkerGroup,
InstallStatusSignatureRuntime,
SqliteDb
} from './installStatusTypes'
import {
  logNodeStateFallbackDisabled,
  logNodeStateFallbackUsed,
  nodeStateFallbackCompatibilityAllowed,
  nodeStateFallbackDeniedMessage,
} from '../../rust-core/nodeStateFallbackCompatibilityRuntime'

export function createInstallStatusWriteRuntime(
  deps: InstallStatusRuntimeDeps,
  helpers: InstallStatusDbRuntime & InstallStatusSignatureRuntime
) {
  async function saveInstallStatusIndex(results: Record<string, InstallCompareResult>, itemsById: Map<string, FontItem>, options: { completeTasks?: boolean } = {}): Promise<void> {
    if (!Object.keys(results).length) return
    const fallbackRows: Array<[string, InstallCompareResult, FontItem]> = []
    for (const [fontId, result] of Object.entries(results)) {
      const item = itemsById.get(fontId)
      if (item) fallbackRows.push([fontId, result, item])
    }

    if (deps.saveInstallStatusIndexInWorker) {
      try {
        const workerGroups: InstallStatusSaveWorkerGroup[] = []
        const toWorkerRows = (rows: Array<[string, InstallCompareResult, FontItem]>) => rows.map(([fontId, result, item]) => ({
          fontId,
          signature: helpers.installStatusSignature(item),
          installed: !!result.installed,
          by: result.by,
          matches: result.matches || [],
          systemDefault: deps.isCleanWindowsDefaultCompareResult(item, result)
        }))
        if (fallbackRows.length) {
          workerGroups.push({
            rootLabel: 'local-fallback',
            rootPath: 'local-fallback',
            dbPath: await helpers.fallbackInstallStatusDbPath(),
            rows: toWorkerRows(fallbackRows)
          })
        }
        const workerResult = await deps.saveInstallStatusIndexInWorker(workerGroups)
        deps.appendStartupLog(`machine install status db worker write: groups=${workerResult.groups}, rows=${workerResult.written}, elapsed=${workerResult.timings?.elapsed || 0}ms`)
        if (options.completeTasks !== false) {
          for (const [fontId, result] of Object.entries(results)) await deps.completeBackgroundTask(helpers.installStatusTaskKey(fontId), result.installed ? '已安装' : '未安装').catch(() => undefined)
        }
        return
      } catch (error) {
        rethrowSharedIoProcessError(error)
        deps.appendStartupLog(`machine install status db worker write fallback: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (!nodeStateFallbackCompatibilityAllowed()) {
      logNodeStateFallbackDisabled({
        appendStartupLog: deps.appendStartupLog,
        source: 'install-status-write',
        reason: 'worker-write-unavailable',
      })
      throw new Error(nodeStateFallbackDeniedMessage('install-status-write'))
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'install-status-write',
      detail: `rows=${Object.keys(results).length}`,
    })

    async function writeRows(rootLabel: string, rows: Array<[string, InstallCompareResult, FontItem]>, openDb: () => Promise<SqliteDb>): Promise<void> {
      if (!rows.length) return
      let db: SqliteDb | null = null
      try {
        db = await openDb()
        const insert = db.prepare(`
          INSERT OR REPLACE INTO install_status (font_id, signature, installed, by_type, matches_json, checked_at, system_default)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        const checkedAt = new Date().toISOString()
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const [fontId, result, item] of rows) {
            insert.run(fontId, helpers.installStatusSignature(item), result.installed ? 1 : 0, result.by, JSON.stringify(result.matches || []), checkedAt, deps.isCleanWindowsDefaultCompareResult(item, result) ? 1 : 0)
          }
          deps.setSqliteMeta(db, 'updatedAt', checkedAt)
          db.exec('COMMIT')
        } catch (error) {
          try { db.exec('ROLLBACK') } catch { /* ignore */ }
          throw error
        }
      } catch (error) {
        deps.appendStartupLog(`machine install status write failed: ${rootLabel} ${error instanceof Error ? error.message : String(error)}`)
        throw error
      } finally {
        if (db) deps.closeSqliteDb(db)
      }
    }

    await writeRows('local-fallback', fallbackRows, () => helpers.openFallbackInstallDb())
    if (options.completeTasks !== false) {
      for (const [fontId, result] of Object.entries(results)) await deps.completeBackgroundTask(helpers.installStatusTaskKey(fontId), result.installed ? '已安装' : '未安装').catch(() => undefined)
    }
  }

  return { saveInstallStatusIndex }
}
