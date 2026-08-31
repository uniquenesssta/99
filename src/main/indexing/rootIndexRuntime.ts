import { promises as fsp } from 'node:fs'
import { sqliteSidecarPaths } from '../cache/cachePaths'
import { rethrowRustCoreDaemonSubmittedWrite } from '../rust-core/rustCoreDaemonWriteBoundaryRuntime'
import {
  logNodeStateFallbackDisabled,
  logNodeStateFallbackUsed,
  nodeStateFallbackCompatibilityAllowed,
  nodeStateFallbackDeniedMessage,
} from '../rust-core/nodeStateFallbackCompatibilityRuntime'
import { ROOT_INDEX_DB_SCHEMA_VERSION } from '../cache/constants'
import { RootCacheLockTimeoutError } from './root-index/rootIndexTypes'
import { createRootIndexDatabaseRuntime } from './root-index/rootIndexDatabaseRuntime'
import { createRootIndexLockRuntime } from './root-index/rootIndexLockRuntime'
import { createRootIndexManifestRuntime } from './root-index/rootIndexManifestRuntime'
import { mergeSharedFontMetadataFromExistingIndex } from './root-index/rootIndexMetadataMergeRuntime'
import { createRootIndexSnapshotRuntime } from './root-index/rootIndexSnapshotRuntime'
import { sqliteEntryFileIdentity, sqliteInsertIndexEvent, sqliteNextOpstamp, sqliteRowToScanEntry } from './root-index/rootIndexSqliteRuntime'
import { assertRootIndexCandidateDbValid, assertRootIndexSwitchAllowed, countRootIndexEntries, readRootIndexCandidateDbCounts } from './root-index/sharedIndexAtomicWriter'
import type { FontScanCacheEntry, FontScanCacheFile, RootIndexRuntimeDeps, RootIndexStorage } from './root-index/rootIndexTypes'

export type { FontScanCacheEntry, FontScanCacheFile, RootIndexStorage } from './root-index/rootIndexTypes'

export function createRootIndexRuntime(deps: RootIndexRuntimeDeps) {
  const {
    rootCacheDirForIndexPath,
    withRootCacheWriteLock,
  } = createRootIndexLockRuntime({
    appendStartupLog: deps.appendStartupLog,
    withGlobalIo: deps.withGlobalIo,
  })
  const {
    openRootIndexDb,
    readRootIndexSqliteFile,
    writeFullRootIndexToOpenDb,
    saveRootIndexSqliteFileDirect,
  } = createRootIndexDatabaseRuntime(deps)
  const {
    resolveActiveRootIndexDbPath,
    writeRootCacheManifest,
    validateRootIndexLatestPointer,
  } = createRootIndexManifestRuntime(deps)
  const {
    rootIndexSnapshotDbPath,
    cleanupOldRootIndexSnapshots,
    inspectRootIndexSnapshotMaintenance,
    cleanupRootIndexSnapshotMaintenance,
    listRootIndexDatabaseFiles,
  } = createRootIndexSnapshotRuntime({
    appendStartupLog: deps.appendStartupLog,
    resolveActiveRootIndexDbPath,
  })

  async function mergeExistingSharedMetadataBeforeFullWrite(filePath: string, rootPath: string, storage: RootIndexStorage, cache: FontScanCacheFile): Promise<void> {
    if (storage !== 'root' || !(await deps.exists(filePath).catch(() => false))) return
    try {
      const existing = await readRootIndexSqliteFile(filePath, rootPath, storage)
      const result = mergeSharedFontMetadataFromExistingIndex(cache, existing)
      if (result.merged) deps.appendStartupLog(`root index full write preserved shared metadata rows=${result.merged}`)
    } catch (error) {
      deps.appendStartupLog(`root index shared metadata merge skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function activeRootIndexEntryCounts(cacheDir: string, filePath: string, rootPath: string, storage: RootIndexStorage) {
    const activePath = await resolveActiveRootIndexDbPath(cacheDir, filePath).catch(() => filePath)
    if (!(await deps.exists(activePath).catch(() => false))) return { total: 0, usable: 0, bad: 0 }
    try {
      const active = await readRootIndexSqliteFile(activePath, rootPath, storage)
      return countRootIndexEntries(active.entries)
    } catch (error) {
      deps.appendStartupLog(`root index active count unavailable before atomic switch: root=${rootPath}, path=${activePath}, error=${error instanceof Error ? error.message : String(error)}`)
      return { total: 0, usable: 0, bad: 0 }
    }
  }

  async function removeSqliteSidecars(filePath: string): Promise<void> {
    for (const sidecar of sqliteSidecarPaths(filePath)) await fsp.rm(sidecar, { force: true }).catch(() => undefined)
  }

  async function saveRootIndexSqliteFileAtomicSnapshot(filePath: string, rootPath: string, storage: RootIndexStorage, cache: FontScanCacheFile, mode: 'full' | 'incremental' = 'full', changeCounts?: { upserts: number; deletes: number }): Promise<string> {
    const cacheDir = rootCacheDirForIndexPath(filePath)
    const snapshotPath = rootIndexSnapshotDbPath(cacheDir)
    const tempPath = `${snapshotPath}.tmp`
    const previousCounts = await activeRootIndexEntryCounts(cacheDir, filePath, rootPath, storage)
    const nextCounts = countRootIndexEntries(cache.entries)

    assertRootIndexSwitchAllowed({
      rootPath,
      storage,
      mode,
      previous: previousCounts,
      next: nextCounts,
      upserts: changeCounts?.upserts,
      deletes: changeCounts?.deletes,
    })

    await removeSqliteSidecars(tempPath)

    let db = await openRootIndexDb(tempPath, rootPath, storage)
    try {
      writeFullRootIndexToOpenDb(db, cache)
      try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch { /* ignore */ }
    } finally {
      deps.closeSqliteDb(db)
    }

    db = await openRootIndexDb(tempPath, rootPath, storage, false)
    try {
      const candidateCounts = readRootIndexCandidateDbCounts(db)
      assertRootIndexCandidateDbValid({
        rootPath,
        storage,
        expected: nextCounts,
        candidate: candidateCounts,
        expectedCacheVersion: deps.fontScanCacheVersion,
      })
    } finally {
      deps.closeSqliteDb(db)
    }

    await removeSqliteSidecars(snapshotPath)
    try {
      await fsp.rename(tempPath, snapshotPath)
    } catch (error) {
      await removeSqliteSidecars(tempPath)
      throw error
    }

    await writeRootCacheManifest(cacheDir, rootPath, storage, nextCounts.total, snapshotPath)
    await cleanupOldRootIndexSnapshots(cacheDir, snapshotPath)
    deps.appendStartupLog(`root index atomic snapshot switched: root=${rootPath}, storage=${storage}, previousUsable=${previousCounts.usable}, nextUsable=${nextCounts.usable}, total=${nextCounts.total}, snapshot=${snapshotPath}`)
    return snapshotPath
  }


  async function saveRootIndexSqliteChangesAtomicSnapshot(filePath: string, rootPath: string, storage: RootIndexStorage, upserts: Array<[string, FontScanCacheEntry]>, deletes: string[]): Promise<string> {
    const cacheDir = rootCacheDirForIndexPath(filePath)
    const activePath = await resolveActiveRootIndexDbPath(cacheDir, filePath).catch(() => filePath)
    const base = await readRootIndexSqliteFile(activePath, rootPath, storage)
    const nextEntries: Record<string, FontScanCacheEntry> = { ...(base.entries || {}) }

    for (const key of deletes) delete nextEntries[key]
    for (const [relativePath, entry] of upserts) nextEntries[relativePath] = entry

    const snapshotPath = await saveRootIndexSqliteFileAtomicSnapshot(filePath, rootPath, storage, {
      version: deps.fontScanCacheVersion,
      entries: nextEntries,
    }, 'incremental', { upserts: upserts.length, deletes: deletes.length })
    deps.appendStartupLog(`root index incremental snapshot switched: root=${rootPath}, storage=${storage}, upserts=${upserts.length}, deletes=${deletes.length}, count=${Object.keys(nextEntries).length}, snapshot=${snapshotPath}`)
    return snapshotPath
  }

  async function saveRootIndexSqliteFile(filePath: string, rootPath: string, storage: RootIndexStorage, cache: FontScanCacheFile): Promise<void> {
    try {
      await withRootCacheWriteLock(filePath, async () => {
        await mergeExistingSharedMetadataBeforeFullWrite(filePath, rootPath, storage, cache)
        if (storage === 'root') {
          await saveRootIndexSqliteFileAtomicSnapshot(filePath, rootPath, storage, cache)
          return
        }

        await saveRootIndexSqliteFileDirect(filePath, rootPath, storage, cache)
        await writeRootCacheManifest(rootCacheDirForIndexPath(filePath), rootPath, storage, Object.keys(cache.entries || {}).length, filePath)
      })
    } catch (error) {
      if (storage === 'root' && error instanceof RootCacheLockTimeoutError) {
        throw new Error(`共享索引写入锁超时：${rootPath}。v2.0 不再写入本机 fallback，请稍后重试或确认没有其他电脑正在更新索引。`)
      }
      throw error
    }
  }

  async function saveRootIndexSqliteChanges(filePath: string, rootPath: string, storage: RootIndexStorage, upserts: Array<[string, FontScanCacheEntry]>, deletes: string[]): Promise<void> {
    if (!upserts.length && !deletes.length) return

    let writtenDatabase = filePath
    try {
      await withRootCacheWriteLock(filePath, async () => {
        if (storage === 'root' && process.env.HFM_ROOT_INDEX_INCREMENTAL_SNAPSHOT !== '0') {
          const snapshotPath = await saveRootIndexSqliteChangesAtomicSnapshot(filePath, rootPath, storage, upserts, deletes)
          writtenDatabase = snapshotPath
          await deps.recordCacheEvent('root-index', 'incremental_snapshot_switch', {
            rootPath,
            storage,
            upserts: upserts.length,
            deletes: deletes.length,
            database: snapshotPath,
          })
          return
        }

        if (deps.runRustRootIndexApplyChanges) {
          try {
            const rustResult = await deps.runRustRootIndexApplyChanges({
              dbPath: filePath,
              rootPath,
              storage,
              schemaVersion: ROOT_INDEX_DB_SCHEMA_VERSION,
              cacheVersion: deps.fontScanCacheVersion,
              scriptDetectionVersion: deps.scriptDetectionVersion,
              upserts,
              deletes,
            })
            if (rustResult?.applied) {
              await writeRootCacheManifest(rootCacheDirForIndexPath(filePath), rootPath, storage, Number(rustResult.count || 0), filePath)
              writtenDatabase = filePath
              deps.appendStartupLog(`root index rust incremental write used: root=${rootPath}, storage=${storage}, upserts=${rustResult.upserts}, deletes=${rustResult.deletes}, count=${rustResult.count}, durationMs=${rustResult.durationMs || 0}`)
              return
            }
          } catch (error) {
            rethrowRustCoreDaemonSubmittedWrite(error, deps.appendStartupLog, 'root index rust incremental write')
            deps.appendStartupLog(`root index rust incremental write fallback: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (!nodeStateFallbackCompatibilityAllowed()) {
          logNodeStateFallbackDisabled({
            appendStartupLog: deps.appendStartupLog,
            source: 'root-index-write',
            reason: 'rust-incremental-write-unavailable',
          })
          throw new Error(nodeStateFallbackDeniedMessage('root-index-write'))
        }
        logNodeStateFallbackUsed({
          appendStartupLog: deps.appendStartupLog,
          source: 'root-index-write',
          detail: `root=${rootPath}, storage=${storage}, upserts=${upserts.length}, deletes=${deletes.length}`,
        })

        const db = await openRootIndexDb(filePath, rootPath, storage)
        try {
          db.exec('BEGIN IMMEDIATE')
          try {
            const markDeleted = db.prepare(`
              UPDATE entries
              SET is_deleted = 1, status = 'deleted', deleted_at = ?, opstamp = ?, revision = COALESCE(revision, 0) + 1
              WHERE relative_path = ?
            `)
            const deletedAt = new Date().toISOString()
            for (const key of deletes) {
              markDeleted.run(deletedAt, sqliteNextOpstamp(db), key)
              sqliteInsertIndexEvent(db, 'delete', key, null, null, { relativePath: key })
            }

            const insert = db.prepare(`
              INSERT INTO entries (
                relative_path, cache_key, file_size, modified_at, created_at, status, font_json, message, cached_at,
                is_deleted, deleted_at, revision, opstamp, file_identity, content_hash
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 1, ?, ?, ?)
              ON CONFLICT(relative_path) DO UPDATE SET
                cache_key = excluded.cache_key,
                file_size = excluded.file_size,
                modified_at = excluded.modified_at,
                created_at = excluded.created_at,
                status = excluded.status,
                font_json = excluded.font_json,
                message = excluded.message,
                cached_at = excluded.cached_at,
                is_deleted = 0,
                deleted_at = NULL,
                revision = COALESCE(entries.revision, 0) + 1,
                opstamp = excluded.opstamp,
                file_identity = excluded.file_identity,
                content_hash = excluded.content_hash
            `)
            for (const [relativePath, entry] of upserts) {
              insert.run(
                relativePath,
                entry.cacheKey,
                Math.round(entry.fileSize || 0),
                Number(entry.modifiedAt || 0),
                entry.createdAt === undefined ? null : Number(entry.createdAt),
                entry.status,
                entry.font ? JSON.stringify(entry.font) : null,
                entry.message || null,
                entry.cachedAt || new Date().toISOString(),
                sqliteNextOpstamp(db),
                sqliteEntryFileIdentity(relativePath, entry),
                entry.contentHash || null
              )
              sqliteInsertIndexEvent(db, 'upsert', relativePath, null, entry.font?.id || null, { relativePath, status: entry.status, fontId: entry.font?.id })
            }

            const count = db.prepare("SELECT COUNT(*) AS count FROM entries WHERE COALESCE(is_deleted, 0) = 0 AND status <> 'deleted'").get() as { count?: number }
            const setMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
            setMeta.run('updatedAt', new Date().toISOString())
            setMeta.run('last_update.entry_state_check', new Date().toISOString())
            setMeta.run('fileCount', String(count?.count || 0))
            db.exec('COMMIT')
            try { db.exec('PRAGMA wal_checkpoint(TRUNCATE);') } catch { /* ignore */ }
            await writeRootCacheManifest(rootCacheDirForIndexPath(filePath), rootPath, storage, Number(count?.count || 0), filePath)
            writtenDatabase = filePath
          } catch (error) {
            try { db.exec('ROLLBACK') } catch { /* ignore */ }
            throw error
          }
        } finally {
          deps.closeSqliteDb(db)
        }
      })
      deps.invalidateSharedFontRuntimeCaches()
      await deps.recordCacheEvent('root-index', 'incremental_write', {
        rootPath,
        storage,
        upserts: upserts.length,
        deletes: deletes.length,
        database: writtenDatabase
      })
    } catch (error) {
      if (storage === 'root' && error instanceof RootCacheLockTimeoutError) {
        throw new Error(`共享索引增量写入锁超时：${rootPath}。v2.0 不再写入本机 fallback，请稍后重试或确认没有其他电脑正在更新索引。`)
      }
      throw error
    }
  }

  return {
    openRootIndexDb,
    readRootIndexSqliteFile,
    saveRootIndexSqliteFile,
    saveRootIndexSqliteChanges,
    writeRootCacheManifest,
    withRootCacheWriteLock,
    resolveActiveRootIndexDbPath,
    validateRootIndexLatestPointer,
    inspectRootIndexSnapshotMaintenance,
    cleanupRootIndexSnapshotMaintenance,
    listRootIndexDatabaseFiles,
    rootCacheDirForIndexPath,
    sqliteRowToScanEntry
  }
}
