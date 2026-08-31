import { resolve } from 'node:path';
import type { FontItem,InstallCompareResult,SystemInstalledFont } from '../../../shared/types';
import type {
InstallStatusDbRuntime,
InstallStatusNormalizeRuntime,
InstallStatusReadWorkerGroup,
InstallStatusRuntimeDeps,
InstallStatusSignatureRuntime,
SqliteDb
} from './installStatusTypes';
import {
  logNodeStateFallbackDisabled,
  logNodeStateFallbackUsed,
  nodeStateFallbackCompatibilityAllowed,
} from '../../rust-core/nodeStateFallbackCompatibilityRuntime';

export function createInstallStatusReadRuntime(
  deps: InstallStatusRuntimeDeps,
  helpers: InstallStatusDbRuntime & InstallStatusSignatureRuntime & InstallStatusNormalizeRuntime
) {
  async function readInstallStatusIndex(items: FontItem[], options: { enqueueMissTasks?: boolean } = { enqueueMissTasks: false }): Promise<{ results: Record<string, InstallCompareResult>; misses: FontItem[] }> {
    const results: Record<string, InstallCompareResult> = {}
    const misses: FontItem[] = []
    const uniqueItems = Array.from(new Map((items || []).filter(Boolean).map((item) => [item.id, item])).values())
    const folders = await deps.appWatchedFolders().catch(() => [])
    const grouped = new Map<string, FontItem[]>()
    const fallbackItems: FontItem[] = []

    for (const item of uniqueItems) {
      const root = await helpers.rootForFontPath(item.path, folders)
      if (!root) {
        fallbackItems.push(item)
        continue
      }
      if (!grouped.has(root)) grouped.set(root, [])
      grouped.get(root)!.push(item)
    }

    if (deps.readInstallStatusIndexInWorker) {
      try {
        const workerGroups: InstallStatusReadWorkerGroup[] = []
        for (const [root, groupItems] of grouped.entries()) {
          workerGroups.push({
            rootLabel: root,
            rootPath: resolve(root),
            dbPath: await helpers.installStatusDbPathForRoot(root),
            items: groupItems.map(helpers.installStatusWorkerItem)
          })
        }
        if (fallbackItems.length) {
          workerGroups.push({
            rootLabel: 'local-fallback',
            rootPath: 'local-fallback',
            dbPath: await helpers.fallbackInstallStatusDbPath(),
            items: fallbackItems.map(helpers.installStatusWorkerItem)
          })
        }
        const workerResult = await deps.readInstallStatusIndexInWorker(workerGroups)
        Object.assign(results, workerResult.results || {})
        const missingSet = new Set(workerResult.missingIds || [])
        const missesFromWorker = uniqueItems.filter((item) => missingSet.has(item.id))
        if (options.enqueueMissTasks && missesFromWorker.length) {
          deps.appendStartupLog(`install status lazy check disabled: ${missesFromWorker.length} missing cached rows were not queued`)
        }
        return { results, misses: missesFromWorker }
      } catch (error) {
        deps.appendStartupLog(`machine install status db worker read fallback: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    if (!nodeStateFallbackCompatibilityAllowed()) {
      logNodeStateFallbackDisabled({
        appendStartupLog: deps.appendStartupLog,
        source: 'install-status-read',
        reason: 'worker-read-unavailable',
      })
      return { results, misses: uniqueItems.filter((item) => !results[item.id]) }
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'install-status-read',
      detail: `items=${uniqueItems.length}`,
    })

    async function readGroup(rootLabel: string, groupItems: FontItem[], openDb: () => Promise<SqliteDb>): Promise<void> {
      if (!groupItems.length) return
      let db: SqliteDb | null = null
      try {
        db = await openDb()
        const select = db.prepare('SELECT signature, installed, by_type, matches_json FROM install_status WHERE font_id = ?')
        for (const item of groupItems) {
          const signature = helpers.installStatusSignature(item)
          const row = select.get(item.id) as { signature?: string; installed?: number; by_type?: string; matches_json?: string } | undefined
          if (row?.signature === signature) {
            const result = helpers.normalizeInstallCompareResult({
              installed: !!row.installed,
              by: row.by_type as InstallCompareResult['by'],
              matches: deps.parseSqliteJson<SystemInstalledFont[]>(row.matches_json, [])
            })
            if (result) {
              results[item.id] = result
              continue
            }
          }
          misses.push(item)
        }
      } catch (error) {
        deps.appendStartupLog(`machine install status read skipped: ${rootLabel} ${error instanceof Error ? error.message : String(error)}`)
        misses.push(...groupItems)
      } finally {
        if (db) deps.closeSqliteDb(db)
      }
    }

    for (const [root, groupItems] of grouped.entries()) await readGroup(root, groupItems, () => helpers.openMachineInstallDbForRoot(root))
    await readGroup('local-fallback', fallbackItems, () => helpers.openFallbackInstallDb())

    if (options.enqueueMissTasks && misses.length) {
      deps.appendStartupLog(`install status lazy check disabled: ${misses.length} missing cached rows were not queued`)
    }

    return { results, misses }
  }

  async function getInstallStatusIndexSnapshot(items: FontItem[]): Promise<{ results: Record<string, InstallCompareResult>; missingIds: string[] }> {
    const uniqueItems = Array.from(new Map((items || []).filter(Boolean).map((item) => [item.id, item])).values())
    const { results, misses } = await readInstallStatusIndex(uniqueItems, { enqueueMissTasks: false })
    return { results, missingIds: misses.map((item) => item.id) }
  }

  return { readInstallStatusIndex, getInstallStatusIndexSnapshot }
}
