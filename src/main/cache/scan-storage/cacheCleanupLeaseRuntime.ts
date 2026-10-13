import { randomUUID } from 'node:crypto'
import { dirname, relative, isAbsolute } from 'node:path'
import { awaitPhysicalIoClose } from '../../path/ioDeadlineRuntime'
import { executeSharedFile, sharedFileSystem as fsp, withoutSharedIoSignal } from '../../path/sharedFileSystemRuntime'
import { ROOT_SCAN_CACHE_LOCK_STALE_MS } from '../constants'

export type CacheCleanupOutcome = { path: string; status: 'removed' | 'missing' | 'failed'; message?: string }
type CleanupGuard = { path: string; identity: unknown; payload: Buffer }

/** Never steal a lease. Native deletion pins every verified owner until commit. */
export async function withCacheCleanupLocks<T>(
  lockPaths: string[],
  action: (remove: (paths: string[]) => Promise<CacheCleanupOutcome[]>) => Promise<T>,
  appendLog: (message: string) => void,
): Promise<T> {
  if (!lockPaths.length) throw new Error('缓存清理缺少排他锁。')
  let cacheRoot = dirname(lockPaths[0])
  for (const path of lockPaths) {
    while (true) {
      const rel = relative(cacheRoot, path)
      if (!rel.startsWith('..') && !isAbsolute(rel)) break
      const parent = dirname(cacheRoot)
      if (parent === cacheRoot) throw new Error('缓存清理锁不属于同一根。')
      cacheRoot = parent
    }
  }
  const guards: CleanupGuard[] = []
  let failed = false
  const startedAt = Date.now()
  try {
    for (const path of [...new Set(lockPaths)]) {
      await fsp.mkdir(dirname(path), { recursive: true })
      const opened = await executeSharedFile({ operation: 'openFile', path, exclusive: true })
      const guard: CleanupGuard = { path, identity: opened.result.value,
        payload: Buffer.from(JSON.stringify({ purpose: 'cache-cleanup', pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() })) }
      guards.push(guard)
      const written = await executeSharedFile({ operation: 'writeOwnedFile', path, identity: guard.identity }, guard.payload)
      guard.identity = written.result.value
    }
    return await action(async paths => {
      // An enumeration that outlived its lease can never authorize deletion.
      if (Date.now() - startedAt >= ROOT_SCAN_CACHE_LOCK_STALE_MS / 2) throw new Error('缓存清理等待过久，已保留尚未删除的缓存，请重试。')
      for (const guard of guards) {
        const written = await executeSharedFile({ operation: 'writeOwnedFile', path: guard.path, identity: guard.identity }, guard.payload)
        guard.identity = written.result.value
      }
      const targets = [...new Set(paths)]
      const receipt = await executeSharedFile({ operation: 'removeWithOwnedLocks', path: guards[0].path,
        rootPath: cacheRoot, paths: targets, guards: guards.map(({ path, identity }) => ({ path, identity })) })
      const outcomes = receipt.result.value as CacheCleanupOutcome[]
      if (!Array.isArray(outcomes) || outcomes.length !== targets.length || outcomes.some((row, index) => row?.path !== targets[index] || !['removed', 'missing', 'failed'].includes(row.status))) {
        throw new Error('缓存清理回执不完整，未确认全部删除。')
      }
      return outcomes
    })
  } catch (error) {
    failed = true
    await awaitPhysicalIoClose(error)
    throw error
  } finally {
    const releaseFailures: string[] = []
    await withoutSharedIoSignal(async () => {
      for (const guard of guards.reverse()) {
        try { await executeSharedFile({ operation: 'removeOwnedFile', path: guard.path, identity: guard.identity }) }
        catch (error) {
          await awaitPhysicalIoClose(error)
          const message = `${guard.path}: ${error instanceof Error ? error.message : String(error)}`
          releaseFailures.push(message)
          try { appendLog(`cache cleanup lease release failed: ${message}`) } catch { /* Preserve the operation failure. */ }
        }
      }
    })
    if (releaseFailures.length && !failed) throw new Error(`缓存清理后锁释放未确认：${releaseFailures.join('；')}`)
  }
}
