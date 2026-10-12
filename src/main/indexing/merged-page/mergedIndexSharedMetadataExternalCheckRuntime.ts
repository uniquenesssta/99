import { resolve } from 'node:path'
import { ensureStartupPathRootAvailable, getStartupPathRootState } from '../../path/startupPathAvailabilityRuntime'
import { assertFreshMergedIndexSource, readMergedIndexAppliedSources } from './mergedIndexSourceRuntime'
import { createMergedIndexSyncRuntime, mergedSyncRootHash } from './mergedIndexSyncRuntime'
import { mergedSyncBlocker, settleMergedSyncError } from './mergedIndexProjectionFailureRuntime'
import type { MergedIndexBuildRuntime, MergedIndexPageContext, MergedIndexSourceRuntime } from './mergedIndexPageTypes'

export type MergedIndexExternalCheckResult = {
  changed: boolean
  rebuilt: boolean
  roots: number
  elapsedMs: number
  reason: string
  status?: 'complete' | 'partial'
  checkedRoots?: number
  syncedRoots?: number
  deferredRoots?: number
  failedRoots?: number
  reconciliationRequired?: boolean
  blockers?: Record<string, number>
}

type RetryState = { failures: number; retryAt: number; generation: number }
const retriesByContext = new WeakMap<MergedIndexPageContext, Map<string, RetryState>>()
const BASE_RETRY_MS = 90_000
const MAX_RETRY_MS = 15 * 60_000

export function isSharedMetadataExternalCheckReason(reason: string): boolean {
  const value = String(reason || '').toLowerCase()
  return value.includes('shared-metadata') || value.includes('shared_metadata')
}

export function isExplicitMergedIndexReconciliation(reason: string): boolean {
  return /(?:manual|repair|reconcile)/i.test(reason)
}

export async function checkMergedIndexSharedMetadataExternalChanges(args: {
  ctx: MergedIndexPageContext
  sourceRuntime: MergedIndexSourceRuntime
  buildRuntime: MergedIndexBuildRuntime
  reason: string
}): Promise<MergedIndexExternalCheckResult> {
  const { ctx, sourceRuntime, buildRuntime, reason } = args
  const startedAt = Date.now()
  const roots = Array.from(new Set((await ctx.appWatchedFolders()).filter(Boolean).map(folder => resolve(folder))))
  const result: MergedIndexExternalCheckResult = { changed: false, rebuilt: false, roots: roots.length, elapsedMs: 0, reason,
    status: 'complete', checkedRoots: 0, syncedRoots: 0, deferredRoots: 0, failedRoots: 0, reconciliationRequired: false, blockers: {} }
  const finish = () => {
    result.status = result.deferredRoots || result.failedRoots || result.reconciliationRequired ? 'partial' : 'complete'
    result.elapsedMs = Date.now() - startedAt
    return result
  }
  if (isExplicitMergedIndexReconciliation(reason)) {
    // Explicit full reconciliation owns removals/schema repair and can repair
    // stale derived rows even when their recorded signatures are identical.
    try {
      for (const root of roots) {
        if (!(await ensureStartupPathRootAvailable(root, undefined, 'shared-metadata-manual-reconciliation'))) throw new Error('root-unavailable')
      }
      const sources = await sourceRuntime.mergedIndexSourcesForRoots(roots)
      if (ctx.mergedIndexRootsKey(sources.map(source => source.root)) !== ctx.mergedIndexRootsKey(roots)) throw new Error('reconciliation-sources-incomplete')
      await ctx.runMergedIndexMutation('shared-metadata-full-reconciliation', async ({ commit }) => {
        if (ctx.mergedIndexRootsKey(await ctx.appWatchedFolders()) !== ctx.mergedIndexRootsKey(roots)) throw new Error('reconciliation-roots-changed')
        const db = await ctx.openMergedIndexDb()
        try { await buildRuntime.rebuildMergedIndexDb(db, sources, ctx.mergedIndexSourcesKey(sources)); commit('shared-metadata-full-reconciliation') }
        finally { ctx.closeSqliteDb(db) }
      })
      result.changed = result.rebuilt = true
      result.checkedRoots = result.syncedRoots = roots.length
      retriesByContext.delete(ctx)
    } catch (error) {
      await settleMergedSyncError(error)
      result.blockers![mergedSyncBlocker(error)] = roots.length || 1
      ctx.appendStartupLog(`merged metadata poll: caller=reconcile, rootHash=all, phase=deferred, blocker=${mergedSyncBlocker(error)}`)
      result.failedRoots = roots.length || 1
      result.reconciliationRequired = true
    }
    return finish()
  }
  if (!roots.length) return finish()
  const retry = retriesByContext.get(ctx) || new Map<string, RetryState>()
  retriesByContext.set(ctx, retry)
  const rootKeys = new Set(roots.map(root => ctx.normalizePathForCacheCompare(root)))
  for (const key of retry.keys()) if (!rootKeys.has(key)) retry.delete(key)
  let applied: ReturnType<typeof readMergedIndexAppliedSources>
  let db: any
  try {
    db = await ctx.openMergedIndexDb()
    applied = readMergedIndexAppliedSources(ctx, db)
    // Configuration changes are not offline evidence. A root-local refresh may
    // add a newly available root; removing a persisted root needs full repair.
    result.reconciliationRequired = !ctx.mergedIndexSourcesMatchRoots(db, roots)
  } catch (error) {
    await settleMergedSyncError(error)
    const blocker = mergedSyncBlocker(error)
    result.failedRoots = roots.length
    result.reconciliationRequired = true
    result.blockers![blocker] = roots.length
    ctx.appendStartupLog(`merged metadata poll: caller=periodic, rootHash=all, phase=deferred, blocker=${blocker}`)
    return finish()
  } finally { if (db) ctx.closeSqliteDb(db) }
  const sourceByRoot = new Map(applied.map(source => [ctx.normalizePathForCacheCompare(source.root), source]))
  const sync = createMergedIndexSyncRuntime(ctx, sourceRuntime, buildRuntime, { background: true })
  const explicit = isExplicitMergedIndexReconciliation(reason)
  const ordered = roots.sort((a, b) => Number(getStartupPathRootState(b).state === 'online') - Number(getStartupPathRootState(a).state === 'online'))
  let cursor = 0
  async function checkRoot(root: string): Promise<void> {
    const key = ctx.normalizePathForCacheCompare(root)
    const rootHash = mergedSyncRootHash(key)
    const state = getStartupPathRootState(root)
    const previousRetry = retry.get(key)
    // A newly confirmed online generation can resume immediately. An offline
    // generation change is not proof of recovery and does not erase backoff.
    if (!explicit && previousRetry && Date.now() < previousRetry.retryAt
      && !(state.state === 'online' && state.generation !== previousRetry.generation)) {
      result.deferredRoots! += 1
      return
    }
    try {
      if (!(await ensureStartupPathRootAvailable(root, undefined, 'shared-metadata-poll', { background: true }))) throw new Error('root-unavailable')
      const available = getStartupPathRootState(root)
      const fresh = await sourceRuntime.mergedIndexSourcesForRoots([root])
      if (fresh.length !== 1) throw new Error('source-unavailable')
      assertFreshMergedIndexSource(fresh[0])
      const afterRead = getStartupPathRootState(root)
      if (afterRead.state !== 'online' || afterRead.generation !== available.generation || afterRead.rootId !== available.rootId) throw new Error('merged-projection-generation-changed')
      result.checkedRoots! += 1
      const previous = sourceByRoot.get(key)
      // Check every target receipt component, including root-index revision.
      // This recovers a committed root checkpoint after a projection crash.
      if (explicit || !previous || ctx.mergedIndexSourcesKey([previous]) !== ctx.mergedIndexSourcesKey(fresh)) {
        await sync.syncMergedIndexForRootSnapshot(root, reason)
        result.changed = true
        result.syncedRoots! += 1
      }
      retry.delete(key)
      ctx.appendStartupLog(`merged metadata poll: caller=${explicit ? 'reconcile' : 'periodic'}, rootHash=${rootHash}, phase=checked, blocker=none`)
    } catch (error) {
      await settleMergedSyncError(error)
      if ((error as { mergedProjectionCommitted?: boolean })?.mergedProjectionCommitted) result.changed = true
      const failures = Math.min(10, (previousRetry?.failures || 0) + 1)
      const delay = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** (failures - 1))
      const current = getStartupPathRootState(root)
      retry.set(key, { failures, retryAt: Date.now() + delay, generation: current.generation })
      if (current.state !== 'online') result.deferredRoots! += 1
      else result.failedRoots! += 1
      const blocker = mergedSyncBlocker(error)
      result.blockers![blocker] = (result.blockers![blocker] || 0) + 1
      ctx.appendStartupLog(`merged metadata poll: caller=${explicit ? 'reconcile' : 'periodic'}, rootHash=${rootHash}, phase=deferred, blocker=${blocker}, retryMs=${delay}`)
    }
  }
  // A slow root occupies only one preparation slot, never the local write lane.
  await Promise.all(Array.from({ length: Math.min(4, ordered.length) }, async () => {
    while (cursor < ordered.length) { const root = ordered[cursor++]; await checkRoot(root); await ctx.delayToEventLoop() }
  }))
  return finish()
}
