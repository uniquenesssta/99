import fs from 'node:fs'
import { ownsCacheMaintenance } from '../../maintenance/cacheMaintenanceCoordinator'
import { executeSharedFile, sharedFileSystem as fsp, withoutSharedIoSignal } from '../../path/sharedFileSystemRuntime'
import os from 'node:os'
import { awaitPhysicalIoClose } from '../../path/ioDeadlineRuntime'
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
  settleHeartbeat: () => Promise<void>
  release: () => Promise<void>
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
    const receipt = await executeSharedFile({ operation: 'removeStaleLock', path: lockPath, olderThanMs: Date.now() - ROOT_SCAN_CACHE_LOCK_STALE_MS })
    if (receipt.result.value !== true) return false
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
  let release: (() => Promise<void>) | undefined

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
      const owned = handle as unknown as { removeOwned?: () => Promise<void> }
      const identity = owned.removeOwned ? undefined : await handle.stat()
      const acquired = handle
      release = () => withoutSharedIoSignal(async () => {
        if (owned.removeOwned) await owned.removeOwned()
        else {
          const current = await fsp.lstat(lockPath)
          if (current.dev === identity?.dev && current.ino === identity?.ino) await fsp.unlink(lockPath)
        }
      }).finally(() => acquired.close())
      await handle.writeFile(payload(), 'utf-8')
      let heartbeatInFlight: Promise<void> | undefined
      const heartbeatTimer = setInterval(() => {
        if (heartbeatInFlight) return
        heartbeatInFlight = withoutSharedIoSignal(async () => {
          if (owned.removeOwned) await acquired.writeFile(payload(), 'utf-8')
          else { await acquired.truncate(0); await acquired.write(payload(), 0, 'utf-8') }
        }).catch(async error => { await awaitPhysicalIoClose(error) }).finally(() => { heartbeatInFlight = undefined })
      }, Math.max(1000, Math.floor(ROOT_SCAN_CACHE_LOCK_STALE_MS / 4)))
      appendStartupLog(`shared index build lease acquired: root=${context.rootPath}, lock=${lockPath}, jobId=${jobId}`)
      return { rootPath: context.rootPath, rootKey, cacheDir: context.cacheDir, lockPath, handle, heartbeatTimer, settleHeartbeat: async () => { await heartbeatInFlight }, release }
    } catch (error) {
      await awaitPhysicalIoClose(error)
      if (release) await release().catch(async error => { await awaitPhysicalIoClose(error) })
      else if (handle) await handle.close().catch(() => undefined)
      release = undefined; handle = null
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

    try {
      for (const context of contexts) {
        if (context.storage !== 'root') continue
        if (ownsCacheMaintenance()) {
          // This advisory lease suppresses duplicate builds only. Maintenance uses
          // its own candidate; the final write lock still serializes activation.
          deps.appendStartupLog(`shared index maintenance bypasses build lease: root=${context.rootPath}, jobId=${jobId}`)
          continue
        }
        const lease = await acquireOneSharedIndexBuildLease({ context, jobId, appendStartupLog: deps.appendStartupLog })
        if (lease) {
          acquired.push(lease)
        } else {
          busyRootKeys.add(normalizePathForCacheCompare(context.rootPath))
          busyRoots.push(context.rootPath)
        }
      }
    } catch (error) {
      await releaseAll(acquired)
      throw error
    }

    return { acquired, busyRootKeys, busyRoots }
  }

  async function releaseAll(leases: SharedIndexBuildLease[]): Promise<void> {
    for (const lease of leases) {
      if (lease.heartbeatTimer) clearInterval(lease.heartbeatTimer)
      await lease.settleHeartbeat()
      try {
        await lease.release()
        deps.appendStartupLog(`shared index build lease released: root=${lease.rootPath}, lock=${lease.lockPath}`)
      } catch (error) {
        await awaitPhysicalIoClose(error)
        deps.appendStartupLog(`shared index build lease release unconfirmed: root=${lease.rootPath}, lock=${lease.lockPath}, ${String(error)}`)
      }
    }
  }

  return { acquireForContexts, releaseAll }
}
