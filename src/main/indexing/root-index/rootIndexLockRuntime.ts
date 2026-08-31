import fs,{ promises as fsp } from 'node:fs'
import os from 'node:os'
import { basename,dirname,join } from 'node:path'
import { isRootIndexDbPath } from '../../cache/cachePaths'
import {
ROOT_CACHE_LOCK_DIR_NAME,
ROOT_INDEX_DB_DIR_NAME,
ROOT_INDEX_LOCK_FILE_NAME,
ROOT_SCAN_CACHE_LOCK_FILE_NAME,
ROOT_SCAN_CACHE_LOCK_STALE_MS,
ROOT_SCAN_CACHE_LOCK_TIMEOUT_MS
} from '../../cache/constants'
import { RootCacheLockTimeoutError } from './rootIndexTypes'

export type RootIndexLockRuntimeDeps = {
  appendStartupLog: (message: string) => void
  withGlobalIo: <T>(label: string, action: () => Promise<T>, options?: { priority?: 'high' | 'normal' | 'low'; lane?: string; storagePath?: string }) => Promise<T>
}

export function createRootIndexLockRuntime(deps: RootIndexLockRuntimeDeps): {
  rootCacheDirForIndexPath: (cachePath: string) => string
  withRootCacheWriteLock: <T>(cachePath: string, action: () => Promise<T>) => Promise<T>
} {
  function rootCacheDirForIndexPath(cachePath: string): string {
    const parent = dirname(cachePath)
    return basename(parent).toLowerCase() === ROOT_INDEX_DB_DIR_NAME.toLowerCase() ? dirname(parent) : parent
  }

  function rootIndexLockPathForCachePath(cachePath: string): string {
    if (isRootIndexDbPath(cachePath)) return join(rootCacheDirForIndexPath(cachePath), ROOT_CACHE_LOCK_DIR_NAME, ROOT_INDEX_LOCK_FILE_NAME)
    return join(dirname(cachePath), ROOT_SCAN_CACHE_LOCK_FILE_NAME)
  }

  async function removeStaleLockIfNeeded(lockPath: string): Promise<void> {
    try {
      const stat = await fsp.stat(lockPath)
      if (Date.now() - stat.mtimeMs > ROOT_SCAN_CACHE_LOCK_STALE_MS) {
        await fsp.rm(lockPath, { force: true })
        deps.appendStartupLog(`root cache stale lock removed: ${lockPath}`)
      }
    } catch {
      // lock does not exist or cannot be inspected
    }
  }

  async function withRootCacheWriteLockUnlocked<T>(cachePath: string, action: () => Promise<T>): Promise<T> {
    const lockPath = rootIndexLockPathForCachePath(cachePath)
    const startedAt = Date.now()
    let handle: fs.promises.FileHandle | null = null
    let heartbeatTimer: NodeJS.Timeout | null = null

    const lockPayload = (createdAt: string) => JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      createdAt,
      heartbeatAt: new Date().toISOString(),
      cachePath,
      lockPath,
      purpose: isRootIndexDbPath(cachePath) ? 'shared-root-index' : 'legacy-root-json'
    }, null, 2)

    while (!handle) {
      try {
        await fsp.mkdir(dirname(lockPath), { recursive: true })
        handle = await fsp.open(lockPath, 'wx')
        const createdAt = new Date().toISOString()
        await handle.writeFile(lockPayload(createdAt), 'utf-8')
        heartbeatTimer = setInterval(() => {
          fsp.writeFile(lockPath, lockPayload(createdAt), 'utf-8').catch(() => undefined)
        }, Math.max(1000, Math.floor(ROOT_SCAN_CACHE_LOCK_STALE_MS / 4)))
        break
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
        if (code !== 'EEXIST') throw error
        await removeStaleLockIfNeeded(lockPath)
        if (Date.now() - startedAt > ROOT_SCAN_CACHE_LOCK_TIMEOUT_MS) {
          deps.appendStartupLog(`root cache lock timeout, skip shared write: ${cachePath}, lock=${lockPath}`)
          throw new RootCacheLockTimeoutError(lockPath)
        }
        const retryDelayMs = 140 + Math.floor(Math.random() * 180)
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
      }
    }

    try {
      return await action()
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      if (handle) await handle.close().catch(() => undefined)
      await fsp.rm(lockPath, { force: true }).catch(() => undefined)
    }
  }

  async function withRootCacheWriteLock<T>(cachePath: string, action: () => Promise<T>): Promise<T> {
    return deps.withGlobalIo('root-cache-write-lock', () => withRootCacheWriteLockUnlocked(cachePath, action), { priority: 'normal', lane: 'sqlite', storagePath: cachePath })
  }

  return {
    rootCacheDirForIndexPath,
    withRootCacheWriteLock
  }
}
