import { mergedSyncBlocker, mergedSyncCause, settleMergedSyncError } from './mergedIndexProjectionFailureRuntime'
import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import { applicationWorkEpoch, assertApplicationOpen } from '../../app/shutdownCoordinatorRuntime'
import { ensureStartupPathRootAvailable, getStartupPathRootState } from '../../path/startupPathAvailabilityRuntime'
import { rethrowSharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import { rethrowRustCoreDaemonSubmittedWrite } from '../../rust-core/rustCoreDaemonWriteBoundaryRuntime'
import type { FontIndexChangePayload } from '../../../shared/types'
import type { MergedIndexSourceInfo } from '../mergedIndexRuntime'
import { assertFreshMergedIndexSource, readMergedIndexAppliedSources } from './mergedIndexSourceRuntime'
import {
  isInstallStatusIncrementalSyncReason, isRootIndexIncrementalSyncReason, isSharedMetadataIncrementalSyncReason,
  sourceKeyChangedOnlyByInstallStatus, sourceKeyChangedOnlyByRootIndex, sourceKeyChangedOnlyBySharedMetadata,
} from './mergedIndexSourceChangeRuntime'
import type { MergedIndexBuildRuntime, MergedIndexPageContext, MergedIndexSourceRuntime } from './mergedIndexPageTypes'

export function mergedSyncRootHash(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 12)
}

// Both writers receive the same normalized rows. No renderer font metadata is
// trusted here: these rows were read from the authoritative target index/overlay.
export function normalizeMergedSyncRows(ctx: MergedIndexPageContext, rows: Parameters<MergedIndexPageContext['bindMergedIndexRow']>[0][], root: string, now: string): Record<string, unknown>[] {
  const seen = new Set<string>()
  return rows.map(row => {
    const relative = String(row.relative_path || '').replaceAll('\\', '/')
    if (!relative || relative.includes('\0') || isAbsolute(relative) || win32.isAbsolute(relative)
      || /^[a-z]:/i.test(relative) || relative.split('/').includes('..') || seen.has(relative)
      || (row.root_path && ctx.normalizePathForCacheCompare(row.root_path) !== ctx.normalizePathForCacheCompare(root))) {
      throw new Error('merged-projection-row-invalid')
    }
    seen.add(relative)
    return ctx.bindMergedIndexRow({ ...row, root_path: root, relative_path: relative }, root, now)
  })
}

export function createMergedIndexSyncRuntime(ctx: MergedIndexPageContext, sourceRuntime: MergedIndexSourceRuntime, _buildRuntime: MergedIndexBuildRuntime, options: { background?: boolean } = {}) {
  function targetKey(sources: MergedIndexSourceInfo[], rootKey: string): string {
    return ctx.mergedIndexSourcesKey(sources.filter(source => ctx.normalizePathForCacheCompare(source.root) === rootKey))
  }

  async function prepare(rootPath: string, reason: string, payload?: FontIndexChangePayload) {
    const epoch = applicationWorkEpoch()
    const roots = await ctx.appWatchedFolders()
    const rootsKey = ctx.mergedIndexRootsKey(roots)
    const rootKey = ctx.normalizePathForCacheCompare(rootPath)
    const configured = roots.find(root => ctx.normalizePathForCacheCompare(root) === rootKey)
    if (!configured) throw new Error('merged-projection-root-removed')
    const db = await ctx.openMergedIndexDb()
    let previous: MergedIndexSourceInfo[]
    try { previous = readMergedIndexAppliedSources(ctx, db) }
    finally { ctx.closeSqliteDb(db) }
    const expectedTarget = targetKey(previous, rootKey)
    if (!(await ensureStartupPathRootAvailable(configured, undefined, 'merged-projection', { background: options.background === true }))) throw new Error('merged-projection-root-unavailable')
    const availability = getStartupPathRootState(configured)
    const assertGeneration = () => {
      assertApplicationOpen(epoch)
      const current = getStartupPathRootState(configured)
      if (current.state !== 'online' || current.generation !== availability.generation || current.rootId !== availability.rootId) throw new Error('merged-projection-generation-changed')
    }
    const assertPreparationCurrent = async () => {
      assertGeneration()
      if (ctx.mergedIndexRootsKey(await ctx.appWatchedFolders()) !== rootsKey) throw new Error('merged-projection-roots-changed')
      assertGeneration()
    }
    const readTargetSource = async () => {
      const sources = await sourceRuntime.mergedIndexSourcesForRoots([configured])
      const source = sources[0]
      if (sources.length !== 1 || !source || ctx.normalizePathForCacheCompare(source.root) !== rootKey) throw new Error('merged-source-receipt-unavailable')
      assertFreshMergedIndexSource(source)
      return source
    }
    let source = await readTargetSource()
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await assertPreparationCurrent()
      const nextTarget = ctx.mergedIndexSourcesKey([source])
      const incrementalAllowed = expectedTarget === nextTarget
        || (isSharedMetadataIncrementalSyncReason(reason) && sourceKeyChangedOnlyBySharedMetadata(expectedTarget, nextTarget, rootKey))
        || (isRootIndexIncrementalSyncReason(reason) && sourceKeyChangedOnlyByRootIndex(expectedTarget, nextTarget, rootKey))
        || (isInstallStatusIncrementalSyncReason(reason) && sourceKeyChangedOnlyByInstallStatus(expectedTarget, nextTarget, rootKey))
      const relativePaths = payload ? sourceRuntime.relativePathsFromFontIndexPayload(source.root, payload) : []
      // Recompute compatibility against the original applied target, including
      // when a first-use overlay/install migration changes the source receipt.
      const fullSnapshot = !payload || !incrementalAllowed || !relativePaths.length
      const now = new Date().toISOString()
      const rows = normalizeMergedSyncRows(ctx, await sourceRuntime.readMergedRowsForSource(source, fullSnapshot ? undefined : relativePaths), source.root, now)
      const verified = await readTargetSource()
      await assertPreparationCurrent()
      if (ctx.mergedIndexSourcesKey([verified]) === nextTarget) {
        return { source, expectedTarget, rootKey, fullSnapshot, relativePaths, rows, now, assertGeneration, rootsKey }
      }
      ctx.appendStartupLog(`merged root projection: caller=prepare, rootHash=${mergedSyncRootHash(rootKey)}, phase=source-recheck, blocker=superseded, cause=source-changed-during-read, attempt=${attempt}, indexChanged=${source.indexDbPath !== verified.indexDbPath || source.indexSignature !== verified.indexSignature}, installChanged=${source.installDbPath !== verified.installDbPath || source.installSignature !== verified.installSignature}, metadataChanged=${source.sharedMetadataSignature !== verified.sharedMetadataSignature}`)
      // Initialization/replay is part of the authoritative read path. Reread
      // once against its new receipt, outside the write lane. Never recapture
      // request identity or retry a failed read, admission, or submitted write.
      source = verified
    }
    throw new Error('merged-source-changed-during-read')
  }

  async function apply(prepared: Awaited<ReturnType<typeof prepare>>, reason: string, commit: (reason?: string) => void) {
    const { source, rootKey, fullSnapshot, relativePaths, rows, now, assertGeneration } = prepared
    // This callback has no remote reads. Slow/offline source preparation never
    // occupies the global local-write lane used by another root's foreground ACK.
    if (ctx.mergedIndexRootsKey(await ctx.appWatchedFolders()) !== prepared.rootsKey) throw new Error('merged-projection-roots-changed')
    assertGeneration()
    const db = await ctx.openMergedIndexDb()
    try {
      const previous = readMergedIndexAppliedSources(ctx, db)
      if (targetKey(previous, rootKey) !== prepared.expectedTarget) throw new Error('merged-projection-target-changed-in-queue')
      const sources = previous.filter(item => ctx.normalizePathForCacheCompare(item.root) !== rootKey)
      sources.push(source)
      const expectedSourcesKey = ctx.getSqliteMeta(db, 'sourcesKey')
      // A partial payload is not a revision-bound delta for the entire root.
      // Keep its prior applied certificate until a complete snapshot covers any
      // concurrent source writes, including recovery after a process restart.
      const sourcesKey = fullSnapshot ? ctx.mergedIndexSourcesKey(sources) : expectedSourcesKey
      // A persisted source row is an applied checkpoint, not proof that an
      // untouched peer is fresh. Never promote this composite key to ready.
      let nativeBytes = 0
      for (const row of rows) { nativeBytes += Buffer.byteLength(JSON.stringify(row), 'utf8'); if (nativeBytes > 32 * 1024 * 1024) break }
      if (nativeBytes <= 32 * 1024 * 1024) {
        let nativeCommitted = false
        try {
          assertGeneration()
          const result = await ctx.rustCoreWorkerRuntime.runRustMergedIndexSync({
            mergedIndexDbPath: ctx.mergedIndexDbPath(), schemaVersion: ctx.schemaVersion,
            sourcesKey, expectedSourcesKey, syncedAt: now, source, relativePaths, fullSnapshot, reason, preparedRows: rows, preserveSourceCheckpoint: !fullSnapshot, assertCurrent: assertGeneration,
          })
          if (result?.synced) {
            nativeCommitted = true
            // Durable writes always invalidate readers, even if delivery became
            // stale while the isolated native transaction was committing.
            commit(fullSnapshot ? `snapshot-rust:${reason}` : `incremental-rust:${reason}`)
            assertGeneration()
            if (ctx.getSqliteMeta(db, 'sourcesKey') !== sourcesKey) throw new Error('merged-projection-native-receipt-mismatch')
            return
          }
        } catch (error) {
          await settleMergedSyncError(error)
          if (nativeCommitted) throw Object.assign(error instanceof Error ? error : new Error('merged-projection-postcommit-invalid'), { mergedProjectionCommitted: true })
          rethrowSharedIoProcessError(error)
          rethrowRustCoreDaemonSubmittedWrite(error)
          // Native success with a rejected postcondition must never replay a write.
          if (ctx.getSqliteMeta(db, 'sourcesKey') !== expectedSourcesKey) throw error
          assertGeneration()
        }
      }
      const insert = ctx.mergedIndexInsertStatement(db)
      const sync = db.transaction(() => {
        assertGeneration()
        if (ctx.getSqliteMeta(db, 'sourcesKey') !== expectedSourcesKey) throw new Error('merged-projection-checkpoint-changed')
        if (fullSnapshot) db.prepare('DELETE FROM entries WHERE root_path = ?').run(source.root)
        else {
          const remove = db.prepare('DELETE FROM entries WHERE root_path = ? AND relative_path = ?')
          for (const relative of relativePaths) remove.run(source.root, relative)
        }
        for (const row of rows) insert.run(row)
        if (fullSnapshot) ctx.writeMergedIndexSourceRow(db, source, now)
        ctx.setSqliteMeta(db, 'sourcesKey', sourcesKey)
        ctx.setSqliteMeta(db, 'updatedAt', now)
        ctx.setSqliteMeta(db, fullSnapshot ? 'lastRootSnapshotSyncReason' : 'lastIncrementalSyncReason', reason)
      })
      sync()
      commit(fullSnapshot ? `snapshot-node:${reason}` : `incremental-node:${reason}`)
    } finally { ctx.closeSqliteDb(db) }
  }

  async function verifyCommittedSource(prepared: Awaited<ReturnType<typeof prepare>>): Promise<void> {
    try {
      // Source revisions can advance independently of this local writer. Check
      // the target again after releasing the global lane before current ACK.
      prepared.assertGeneration()
      const current = await sourceRuntime.mergedIndexSourcesForRoots([prepared.source.root])
      if (ctx.mergedIndexSourcesKey(current) !== ctx.mergedIndexSourcesKey([prepared.source])) throw new Error('merged-source-changed-after-commit')
      if (ctx.mergedIndexRootsKey(await ctx.appWatchedFolders()) !== prepared.rootsKey) throw new Error('merged-projection-roots-changed')
      prepared.assertGeneration()
    } catch (error) {
      await settleMergedSyncError(error)
      throw Object.assign(error instanceof Error ? error : new Error('merged-projection-postcommit-unavailable'), { mergedProjectionCommitted: true })
    }
  }

  async function syncMergedIndexForRootIncremental(rootPath: string, payload: FontIndexChangePayload, reason: string): Promise<void> {
    const rootHash = mergedSyncRootHash(ctx.normalizePathForCacheCompare(rootPath))
    try {
      const prepared = await prepare(rootPath, reason, payload)
      await ctx.runMergedIndexMutation(`root-incremental:${rootHash}`, async ({ commit }) => apply(prepared, reason, commit))
      await verifyCommittedSource(prepared)
      ctx.appendStartupLog(`merged root projection: caller=incremental, rootHash=${rootHash}, phase=committed, blocker=none, rows=${prepared.rows.length}, fullSnapshot=${prepared.fullSnapshot}`)
    } catch (error) {
      await settleMergedSyncError(error)
      ctx.appendStartupLog(`merged root projection: caller=incremental, rootHash=${rootHash}, phase=deferred, blocker=${mergedSyncBlocker(error)}, cause=${mergedSyncCause(error)}`)
      throw error
    }
  }

  async function syncMergedIndexForRootSnapshot(rootPath: string, reason: string): Promise<void> {
    const rootHash = mergedSyncRootHash(ctx.normalizePathForCacheCompare(rootPath))
    try {
      const prepared = await prepare(rootPath, reason)
      await ctx.runMergedIndexMutation(`root-snapshot:${rootHash}`, async ({ commit }) => apply(prepared, reason, commit))
      await verifyCommittedSource(prepared)
      ctx.appendStartupLog(`merged root projection: caller=snapshot, rootHash=${rootHash}, phase=committed, blocker=none, rows=${prepared.rows.length}`)
    } catch (error) {
      await settleMergedSyncError(error)
      ctx.appendStartupLog(`merged root projection: caller=snapshot, rootHash=${rootHash}, phase=deferred, blocker=${mergedSyncBlocker(error)}, cause=${mergedSyncCause(error)}`)
      throw error
    }
  }

  return { syncMergedIndexForRootIncremental, syncMergedIndexForRootSnapshot }
}
