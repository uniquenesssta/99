import { resolve } from 'node:path';
import type { InstallStatusRuntimeDeps,SqliteDb } from './installStatusTypes';

export function createInstallStatusSummaryRuntime(
  deps: InstallStatusRuntimeDeps,
  helpers: {
    openMachineInstallDbForRoot: (rootPath: string) => Promise<SqliteDb>
  }
) {
  function setMachineInstallSummaryMeta(db: SqliteDb, summary: { installedTotalCount: number; checkedAt: string }): void {
    deps.setSqliteMeta(db, 'installedTotalCount', String(Math.max(0, summary.installedTotalCount || 0)))
    deps.setSqliteMeta(db, 'installedTotalCheckedAt', summary.checkedAt)
  }

  function readMachineInstallSummaryMeta(db: SqliteDb): { installedTotalCount: number; checkedAt: string } | null {
    try {
      const total = Number(deps.getSqliteMeta(db, 'installedTotalCount') || '')
      const checkedAt = deps.getSqliteMeta(db, 'installedTotalCheckedAt') || ''
      if (Number.isFinite(total) && total > 0) return { installedTotalCount: Math.floor(total), checkedAt }
    } catch {
      // ignore summary read failures
    }
    return null
  }

  async function saveInstalledTotalSummaryForRoots(roots: string[], installedTotalCount: number): Promise<void> {
    const checkedAt = new Date().toISOString()
    const uniqueRoots = Array.from(new Set((roots || []).filter(Boolean).map((root) => resolve(root))))
    for (const root of uniqueRoots) {
      let db: SqliteDb | null = null
      try {
        db = await helpers.openMachineInstallDbForRoot(root)
        setMachineInstallSummaryMeta(db, { installedTotalCount, checkedAt })
        deps.setSqliteMeta(db, 'updatedAt', checkedAt)
      } catch (error) {
        deps.appendStartupLog(`machine install total summary write failed: ${root} ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (db) deps.closeSqliteDb(db)
      }
    }
  }

  async function readInstalledTotalSummaryForRoots(roots: string[]): Promise<number | null> {
    const uniqueRoots = Array.from(new Set((roots || []).filter(Boolean).map((root) => resolve(root))))
    for (const root of uniqueRoots) {
      let db: SqliteDb | null = null
      try {
        db = await helpers.openMachineInstallDbForRoot(root)
        const summary = readMachineInstallSummaryMeta(db)
        if (summary) return summary.installedTotalCount
      } catch (error) {
        deps.appendStartupLog(`machine install total summary read skipped: ${root} ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        if (db) deps.closeSqliteDb(db)
      }
    }
    return null
  }

  return {
    setMachineInstallSummaryMeta,
    readMachineInstallSummaryMeta,
    saveInstalledTotalSummaryForRoots,
    readInstalledTotalSummaryForRoots
  }
}
