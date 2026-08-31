import fs,{ promises as fsp } from 'node:fs'
import { isIsoOlderThan, walkPreviewPngFiles } from './databaseMaintenanceHelpers'
import type { DatabaseMaintenanceRuntimeOptions, PreviewMaintenanceReport } from './databaseMaintenanceTypes'

export interface PreviewCacheMaintenanceRuntimeDeps {
  previewOkRetentionMs: number
  openPreviewDb: DatabaseMaintenanceRuntimeOptions['openPreviewDb']
  previewSqlitePath: DatabaseMaintenanceRuntimeOptions['previewSqlitePath']
  previewSqliteSchemaVersion: DatabaseMaintenanceRuntimeOptions['previewSqliteSchemaVersion']
  collectPreviewMaintenanceDirs: DatabaseMaintenanceRuntimeOptions['collectPreviewMaintenanceDirs']
  normalizePathForCacheCompare: DatabaseMaintenanceRuntimeOptions['normalizePathForCacheCompare']
  runRustPreviewCacheMaintenance?: DatabaseMaintenanceRuntimeOptions['runRustPreviewCacheMaintenance']
}

export function createPreviewCacheMaintenanceRuntime(deps: PreviewCacheMaintenanceRuntimeDeps) {
  async function runPreviewCacheMaintenance(): Promise<PreviewMaintenanceReport> {
    const previewDirs = await deps.collectPreviewMaintenanceDirs()
    const rustResult = await deps.runRustPreviewCacheMaintenance?.({
      dbPath: deps.previewSqlitePath(),
      schemaVersion: deps.previewSqliteSchemaVersion,
      now: new Date().toISOString(),
      previewDirs,
      previewOkRetentionMs: deps.previewOkRetentionMs,
      orphanRetentionMs: 7 * 24 * 60 * 60 * 1000,
    }).catch(() => null)
    if (rustResult) return {
      checkedRows: rustResult.checkedRows,
      staleRows: rustResult.staleRows,
      removedFiles: rustResult.removedFiles,
      removedOrphanFiles: rustResult.removedOrphanFiles,
      errors: rustResult.errors || [],
    }

    const report: PreviewMaintenanceReport = { checkedRows: 0, staleRows: 0, removedFiles: 0, removedOrphanFiles: 0, errors: [] }
    const db = await deps.openPreviewDb()
    const now = new Date().toISOString()
    const okRows = db.prepare(`
      SELECT preview_key, output_path, accessed_at, generated_at, updated_at
      FROM preview_cache
      WHERE status = 'ok'
    `).all() as Array<{ preview_key: string; output_path?: string; accessed_at?: string | null; generated_at?: string | null; updated_at?: string | null }>

    const markStale = db.prepare(`
      UPDATE preview_cache
      SET status = 'stale', message = ?, updated_at = ?
      WHERE preview_key = ?
    `)
    const referencedPaths = new Set<string>()

    for (const row of okRows) {
      report.checkedRows += 1
      const outputPath = row.output_path || ''
      if (outputPath) referencedPaths.add(deps.normalizePathForCacheCompare(outputPath))

      let shouldStale = false
      let reason = ''
      if (!outputPath || !fs.existsSync(outputPath)) {
        shouldStale = true
        reason = '预览文件不存在，已标记为需要重建。'
      } else if (isIsoOlderThan(row.accessed_at || row.generated_at || row.updated_at, deps.previewOkRetentionMs)) {
        shouldStale = true
        reason = '预览缓存长期未访问，已标记为需要重建。'
        try {
          await fsp.rm(outputPath, { force: true })
          report.removedFiles += 1
        } catch (error) {
          report.errors.push(`删除过期预览失败：${outputPath} ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (shouldStale) {
        try {
          markStale.run(reason, now, row.preview_key)
          report.staleRows += 1
        } catch (error) {
          report.errors.push(`标记预览缓存 stale 失败：${row.preview_key} ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    const orphanThreshold = 7 * 24 * 60 * 60 * 1000
    for (const dir of previewDirs) {
      await walkPreviewPngFiles(dir, async (filePath) => {
        const normalized = deps.normalizePathForCacheCompare(filePath)
        if (referencedPaths.has(normalized)) return
        try {
          const stat = await fsp.stat(filePath)
          if (Date.now() - stat.mtimeMs < orphanThreshold) return
          await fsp.rm(filePath, { force: true })
          report.removedOrphanFiles += 1
        } catch (error) {
          report.errors.push(`清理孤立预览失败：${filePath} ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    }

    return report
  }

  return { runPreviewCacheMaintenance }
}
