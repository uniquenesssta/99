import { promises as fsp } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { ROOT_SCAN_CACHE_LOCK_STALE_MS, ROOT_SCAN_CACHE_LOCK_TIMEOUT_MS } from '../../cache/constants'
import { sharedMetadataLockPathForRoot } from './sharedMetadataPathsRuntime'

export interface SharedMetadataLockRuntimeDeps {
  appendStartupLog: (message: string) => void
}

export function createSharedMetadataLockRuntime(deps: SharedMetadataLockRuntimeDeps) {
  async function withSharedMetadataWriteLock<T>(rootPath: string, action: () => Promise<T>): Promise<T> {
    const lockPath = sharedMetadataLockPathForRoot(rootPath)
    const startedAt = Date.now()
    let handle: any | null = null
    let heartbeatTimer: NodeJS.Timeout | null = null

    const lockPayload = (createdAt: string) => JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      createdAt,
      heartbeatAt: new Date().toISOString(),
      rootPath: resolve(rootPath),
      lockPath,
      purpose: 'shared-font-metadata',
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
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as NodeJS.ErrnoException).code) : ''
        if (code !== 'EEXIST') throw error
        try {
          const stat = await fsp.stat(lockPath)
          if (Date.now() - stat.mtimeMs > ROOT_SCAN_CACHE_LOCK_STALE_MS) {
            await fsp.rm(lockPath, { force: true })
            deps.appendStartupLog(`shared metadata stale lock removed: ${lockPath}`)
          }
        } catch {
          // ignore missing or unreadable lock
        }
        if (Date.now() - startedAt > ROOT_SCAN_CACHE_LOCK_TIMEOUT_MS) {
          throw new Error(`共享元数据写入锁超时：${rootPath}。请稍后重试或确认没有其他电脑正在批量修改共享标签。`)
        }
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 120 + Math.floor(Math.random() * 220)))
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

  return { withSharedMetadataWriteLock }
}
