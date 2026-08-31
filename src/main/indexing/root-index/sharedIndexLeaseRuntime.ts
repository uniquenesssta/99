import fs,{ promises as fsp } from 'node:fs'
import os from 'node:os'
import { dirname,join } from 'node:path'
import { ROOT_CACHE_LOCK_DIR_NAME,ROOT_INDEX_BUILD_LOCK_FILE_NAME,ROOT_SCAN_CACHE_LOCK_STALE_MS } from '../../cache/constants'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import type { RootScanCacheContext } from '../../watcher/watchedFolderIndexRuntime'

type SharedIndexBuildLease = {
  rootPath: string
  rootKey: string
  cacheDir: string
  lockPath: string
  handle: fs.promises.FileHandle
  heartbeatTimer: NodeJS.Timeout | null
}

export type SharedIndexBuildLeaseRuntimeDeps = {
  appendStartupLog: (message: string) => void
}

export type SharedIndexBuildLeaseResult = {
  acquired: SharedIndexBuildLease[]
  busyRootKeys: Set<string>
  busyRoots: string[]
}

function sharedIndexBuildLockPath(cacheDir: string): string {
  return join(cacheDir, ROOT_CACHE_LOCK_DIR_NAME, ROOT_INDEX_BUILD_LOCK_FILE_NAME)
}

function isErrno(error: unknown, code: string): boolean {
  return !!error && typeof error === 'object' && 'code' in error && String((error as NodeJS.ErrnoException).code) === code
}

async function readExistingLockOwner(lockPath: string): Promise<string> {
  try {
    const raw = await fsp.readFile(lockPath, 'utf-8')
    const parsed = JSON.parse(raw) as { host?: string; pid?: number; startedAt?: string; heartbeatAt?: string; jobId?: string }
    return `host=${parsed.host || 'unknown'}, pid=${parsed.pid || 'unknown'}, jobId=${parsed.jobId || 'unknown'}, heartbeat=${parsed.heartbeatAt || parsed.startedAt || 'unknown'}`
  } catch {
    return 'owner=unknown'
  }
}

async function removeStaleBuildLock(lockPath: string, appendStartupLog: (message: string) => void): Promise<boolean> {
  try {
    const stat = await fsp.stat(lockPath)
    if (Date.now() - stat.mtimeMs <= ROOT_SCAN_CACHE_LOCK_STALE_MS) return false
    await fsp.rm(lockPath, { force: true })
    appendStartupLog(`shared index build stale lease removed: lock=${lockPath}`)
    return true
  } catch {
    return false
  }
}

async function acquireOneSharedIndexBuildLease(args: {
  context: RootScanCacheContext
  jobId: string
  appendStartupLog: (message: string) => void
}): Promise<SharedIndexBuildLease | null> {
  const { context, jobId, appendStartupLog } = args
  if (context.storage !== 'root') return null

  const lockPath = sharedIndexBuildLockPath(context.cacheDir)
  const rootKey = normalizePathForCacheCompare(context.rootPath)
  const startedAt = new Date().toISOString()
  let handle: fs.promises.FileHandle | null = null

  const payload = () => JSON.stringify({
    version: 1,
    purpose: 'shared-index-build',
    rootPath: context.rootPath,
    cacheDir: context.cacheDir,
    lockPath,
    host: os.hostname(),
    pid: process.pid,
    jobId,
    startedAt,
    heartbeatAt: new Date().toISOString(),
    ttlMs: ROOT_SCAN_CACHE_LOCK_STALE_MS,
  }, null, 2)

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.mkdir(dirname(lockPath), { recursive: true })
      handle = await fsp.open(lockPath, 'wx')
      await handle.writeFile(payload(), 'utf-8')
      const heartbeatTimer = setInterval(() => {
        fsp.writeFile(lockPath, payload(), 'utf-8').catch(() => undefined)
      }, Math.max(1000, Math.floor(ROOT_SCAN_CACHE_LOCK_STALE_MS / 4)))
      appendStartupLog(`shared index build lease acquired: root=${context.rootPath}, lock=${lockPath}, jobId=${jobId}`)
      return { rootPath: context.rootPath, rootKey, cacheDir: context.cacheDir, lockPath, handle, heartbeatTimer }
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error
      if (await removeStaleBuildLock(lockPath, appendStartupLog)) continue
      const owner = await readExistingLockOwner(lockPath)
      appendStartupLog(`shared index build lease busy: root=${context.rootPath}, lock=${lockPath}, ${owner}`)
      return null
    }
  }

  return null
}

export function createSharedIndexLeaseRuntime(deps: SharedIndexBuildLeaseRuntimeDeps): {
  acquireForContexts: (contexts: Iterable<RootScanCacheContext>, jobId: string) => Promise<SharedIndexBuildLeaseResult>
  releaseAll: (leases: SharedIndexBuildLease[]) => Promise<void>
} {
  async function acquireForContexts(contexts: Iterable<RootScanCacheContext>, jobId: string): Promise<SharedIndexBuildLeaseResult> {
    const acquired: SharedIndexBuildLease[] = []
    const busyRootKeys = new Set<string>()
    const busyRoots: string[] = []

    for (const context of contexts) {
      if (context.storage !== 'root') continue
      const lease = await acquireOneSharedIndexBuildLease({ context, jobId, appendStartupLog: deps.appendStartupLog })
      if (lease) {
        acquired.push(lease)
      } else {
        busyRootKeys.add(normalizePathForCacheCompare(context.rootPath))
        busyRoots.push(context.rootPath)
      }
    }

    return { acquired, busyRootKeys, busyRoots }
  }

  async function releaseAll(leases: SharedIndexBuildLease[]): Promise<void> {
    for (const lease of leases) {
      if (lease.heartbeatTimer) clearInterval(lease.heartbeatTimer)
      await lease.handle.close().catch(() => undefined)
      await fsp.rm(lease.lockPath, { force: true }).catch(() => undefined)
      deps.appendStartupLog(`shared index build lease released: root=${lease.rootPath}, lock=${lease.lockPath}`)
    }
  }

  return { acquireForContexts, releaseAll }
}
