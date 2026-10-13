import { createHash } from 'node:crypto'
import type { InstallStatusReadEvidence, InstallStatusMissReason } from './installStatusTypes'
import { rethrowSharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { assertSharedIoActive, rethrowSharedIoCancellation } from '../../path/sharedIoCancellationRuntime'
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
  async function readInstallStatusIndex(items: FontItem[], options: { enqueueMissTasks?: boolean } = { enqueueMissTasks: false }): Promise<{ results: Record<string, InstallCompareResult>; misses: FontItem[] } & InstallStatusReadEvidence> {
    assertSharedIoActive()
    const results: Record<string, InstallCompareResult> = {}
    const misses: FontItem[] = []
    const missingReasons: Record<string, InstallStatusMissReason> = {}
    let readError = false
    const uniqueItems = Array.from(new Map((items || []).filter(Boolean).map((item) => [item.id, item])).values())
    const fallbackItems = uniqueItems
    const allowedMissReasons = new Set(['missing-db', 'missing-row', 'signature-mismatch', 'explicit-unknown', 'legacy-evidence', 'invalid-row', 'invalid-identity', 'reader-unavailable', 'read-error', 'worker-omission'])
    const logMisses = (missed: FontItem[], reasons: Record<string, InstallStatusMissReason>) => {
      if (!missed.length) return
      const cause = (item: FontItem) => allowedMissReasons.has(reasons[item.id]) ? reasons[item.id] : 'worker-omission'
      const counts: Record<string, number> = {}
      for (const item of missed) counts[cause(item)] = (counts[cause(item)] || 0) + 1
      try { deps.appendStartupLog(`install status authority misses: count=${missed.length}, causes=${JSON.stringify(counts)}, examples=${JSON.stringify(missed.slice(0, 3).map(item => ({ idHash: createHash('sha256').update(item.id).digest('hex').slice(0, 12), cause: cause(item) })))}`) }
      catch { /* Diagnostic delivery cannot change status authority. */ }
    }

    if (deps.readInstallStatusIndexInWorker) {
      try {
        const workerGroups: InstallStatusReadWorkerGroup[] = []
        if (fallbackItems.length) {
          workerGroups.push({
            rootLabel: 'local-fallback',
            rootPath: 'local-fallback',
            dbPath: await helpers.fallbackInstallStatusDbPath(),
            items: fallbackItems.map(helpers.installStatusWorkerItem)
          })
        }
        assertSharedIoActive()
        const workerResult = await deps.readInstallStatusIndexInWorker(workerGroups)
        assertSharedIoActive()
        Object.assign(results, workerResult.results || {})
        const missesFromWorker = uniqueItems.filter((item) => !Object.hasOwn(results, item.id))
        for (const item of missesFromWorker) {
          const reason = workerResult.missingReasons?.[item.id]
          missingReasons[item.id] = reason && allowedMissReasons.has(reason) ? reason : 'worker-omission'
        }
        if (options.enqueueMissTasks && missesFromWorker.length) {
          deps.appendStartupLog(`install status lazy check disabled: ${missesFromWorker.length} missing cached rows were not queued`)
        }
        logMisses(missesFromWorker, missingReasons)
        return { results, misses: missesFromWorker, missingReasons, readError: workerResult.readError === true }
      } catch (error) {
        rethrowSharedIoProcessError(error)
        rethrowSharedIoCancellation(error)
        deps.appendStartupLog(`machine install status db worker read fallback: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    assertSharedIoActive()
    if (!nodeStateFallbackCompatibilityAllowed()) {
      logNodeStateFallbackDisabled({
        appendStartupLog: deps.appendStartupLog,
        source: 'install-status-read',
        reason: 'worker-read-unavailable',
      })
      return { results, misses: uniqueItems.filter((item) => !results[item.id]), readError: true, missingReasons: Object.fromEntries(uniqueItems.map(item => [item.id, 'reader-unavailable' as const])) }
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
        assertSharedIoActive()
        db = await openDb()
        assertSharedIoActive()
        const select = db.prepare('SELECT signature, installed, by_type, matches_json FROM install_status WHERE font_id = ?')
        for (const item of groupItems) {
          const signature = helpers.installStatusSignature(item)
          const row = select.get(item.id) as { signature?: string; installed?: number; by_type?: string; matches_json?: string } | undefined
          if (row?.signature === signature && (row.installed === 0 || row.installed === 1)) {
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
          missingReasons[item.id] = !row ? 'missing-row' : row.signature?.startsWith('unknown:') ? 'explicit-unknown' : !row.signature?.startsWith('content-v1:') ? 'legacy-evidence' : row.signature !== signature ? 'signature-mismatch' : 'invalid-row'
          misses.push(item)
        }
      } catch (error) {
        rethrowSharedIoProcessError(error)
        rethrowSharedIoCancellation(error)
        deps.appendStartupLog(`machine install status read skipped: ${rootLabel} ${error instanceof Error ? error.message : String(error)}`)
        readError = true
        for (const item of groupItems) missingReasons[item.id] = 'read-error'
        misses.push(...groupItems)
      } finally {
        if (db) deps.closeSqliteDb(db)
      }
    }

    await readGroup('local-fallback', fallbackItems, () => helpers.openFallbackInstallDb())
    assertSharedIoActive()

    if (options.enqueueMissTasks && misses.length) {
      deps.appendStartupLog(`install status lazy check disabled: ${misses.length} missing cached rows were not queued`)
    }

    logMisses(misses, missingReasons)
    return { results, misses, missingReasons, readError }
  }

  async function getInstallStatusIndexSnapshot(items: FontItem[]): Promise<{ results: Record<string, InstallCompareResult>; missingIds: string[] }> {
    const uniqueItems = Array.from(new Map((items || []).filter(Boolean).map((item) => [item.id, item])).values())
    const { results, misses } = await readInstallStatusIndex(uniqueItems, { enqueueMissTasks: false })
    return { results, missingIds: misses.map((item) => item.id) }
  }

  return { readInstallStatusIndex, getInstallStatusIndexSnapshot }
}
