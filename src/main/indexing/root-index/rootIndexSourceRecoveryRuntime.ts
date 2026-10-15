import { resolve } from 'node:path'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import type { ScanResult } from '../../../shared/types'
import { sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { readRootIndexRebuildRequest } from './rootIndexRebuildRequestRuntime'

interface SourceRecoveryOptions {
  cacheDir: (root: string) => string
  defaultDbPath: (root: string) => string
  resolveActiveDbPath: (cacheDir: string, defaultPath: string) => Promise<string>
  isClosing: () => boolean
  isScanActive: () => boolean
  isWatched: (root: string) => Promise<boolean>
  isRootAvailable: (root: string) => Promise<boolean>
  scanWhenIdle: (root: string, signal: AbortSignal) => Promise<ScanResult>
  syncProjection: (root: string) => Promise<void>
  log: (message: string) => void
}

// Directory equality is not source availability. Probe only the small request,
// pointer and file, never a full shared SQLite snapshot/hash on each poll.
export function createRootIndexSourceRecoveryRuntime(options: SourceRecoveryOptions) {
  const rootKey = (root: string) => normalizePathForCacheCompare(resolve(root))
  const paused = new Set<string>()
  const active = new Map<string, Promise<void>>()
  const projectionPending = new Set<string>()
  async function ensureReady(root: string, signal: AbortSignal): Promise<void> {
    const key = rootKey(root)
    const guard = () => { if (signal.aborted || options.isClosing()) throw new Error('watcher-generation-cancelled') }
    guard()
    const request = await readRootIndexRebuildRequest(options.cacheDir(root))
    const dbPath = await options.resolveActiveDbPath(options.cacheDir(root), options.defaultDbPath(root))
    let missing = false
    try { await fsp.stat(dbPath) }
    catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
      missing = true
    }
    guard()
    if (!request && !missing && !projectionPending.has(key)) return
    if (paused.has(key)) throw new Error('source-recovery-cancelled-awaiting-user')
    guard()
    let recovery = active.get(key)
    if (!recovery) {
      if (options.isScanActive()) throw new Error('source-recovery-deferred')
      recovery = (async () => {
        if (!await options.isRootAvailable(root)) throw new Error('root-offline')
        guard()
        if (!await options.isWatched(root)) throw new Error('watcher-generation-cancelled')
        if (request || missing) {
          // A source activation may commit before the scan's final cancellation
          // check. Keep projection debt even when the result becomes cancelled.
          projectionPending.add(key)
          const result = await options.scanWhenIdle(root, signal)
          guard()
          if (result.stats?.cancelled) {
            if (options.isScanActive()) throw new Error('source-recovery-deferred')
            paused.add(key); throw new Error('source-recovery-cancelled-awaiting-user')
          }
          if (result.errors.length || !(result.committedFolders || []).includes(root)) throw new Error('source-recovery-unconfirmed')
        }
        guard()
        await options.syncProjection(root)
        projectionPending.delete(key)
        guard()
        if (await readRootIndexRebuildRequest(options.cacheDir(root))) throw new Error('source-rebuild-acknowledgement-pending')
        guard()
        options.log(`root index watcher recovery complete: root=${root}`)
      })()
      active.set(key, recovery)
    }
    try { await recovery }
    finally { if (active.get(key) === recovery) active.delete(key) }
  }
  return {
    ensureReady,
    pauseActive: () => { for (const key of active.keys()) paused.add(key) },
    pause: (roots: string[]) => { for (const root of roots) paused.add(rootKey(root)) },
    resume: (roots: string[]) => { for (const root of roots) paused.delete(rootKey(root)) },
  }
}
