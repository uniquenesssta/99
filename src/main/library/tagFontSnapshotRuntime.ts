import type { FontItem } from '../../shared/types'
import { normalizePathForCacheCompare } from '../path/cachePath'
import { readFontContentIdentity, readFontIdentityMetadata } from '../fonts/fontContentIdentityRuntime'
import { withSharedIoPriority, withSharedIoSignal } from '../path/sharedFileSystemRuntime'
import { isApplicationClosing, onApplicationClosing } from '../app/shutdownCoordinatorRuntime'

const owners = new WeakMap<object, ReturnType<typeof createTagFontSnapshots>>()
export function disposeTagFontSnapshots(db: any): void { if (db) { owners.get(db)?.dispose(); owners.delete(db) } }
export function openTagFontSnapshots(db: any) {
  let owner = owners.get(db)
  if (!owner) { owner = createTagFontSnapshots(db); owners.set(db, owner) }
  return owner
}

// Durable history is main-owned. Tag assignments still await capture; ordinary
// pages only queue low-priority, coalesced capture and never wait for font bytes.
function createTagFontSnapshots(db: any) {
  db.exec('CREATE TABLE IF NOT EXISTS tag_font_snapshots (font_path TEXT PRIMARY KEY, font_json TEXT NOT NULL)')
  const read = db.prepare('SELECT font_json FROM tag_font_snapshots WHERE font_path = ?')
  const write = db.prepare('INSERT OR REPLACE INTO tag_font_snapshots (font_path, font_json) VALUES (?, ?)')
  let disposed = false
  const pending = new Map<string, { item: FontItem; generation: number | undefined }>()
  const generations = new Map<string, number>()
  let active: { key: string; item: FontItem; controller: AbortController } | undefined
  let draining: Promise<void> | undefined
  let foregroundReaders = 0
  let backgroundLog: ((message: string) => void) | undefined
  const idleWaiters = new Set<() => void>()
  const open = () => !disposed && db.open !== false && db.isOpen !== false
  const identity = (item?: FontItem) => item ? JSON.stringify([item.id, item.fileSize, item.modifiedAt]) : ''
  const snapshotJson = (item: FontItem, recoveryContentHash?: string, recoveryFileStamp?: string) => {
    const { tagNames: _shared, localTagNames: _local, recoveryContentHash: _untrusted, recoveryFileStamp: _untrustedStamp, ...metadata } = item
    return JSON.stringify({ ...metadata, recoveryContentHash, recoveryFileStamp: recoveryContentHash ? recoveryFileStamp : undefined, tagNames: [], localTagNames: [] })
  }
  const previous = (path: string): FontItem | undefined => {
    if (!open()) return undefined
    try { const row = read.get(normalizePathForCacheCompare(path)); return row ? JSON.parse(row.font_json) : undefined } catch { return undefined }
  }
  function remember(items: FontItem[]): { examined: number; written: number } {
    const counts = { examined: 0, written: 0 }
    if (!open()) return counts
    db.transaction(() => {
      for (const item of items) {
        if (!item.path || item.fileAvailability === 'missing' || item.fileAvailability === 'unavailable') continue
        counts.examined++
        const key = normalizePathForCacheCompare(item.path)
        const stored = read.get(key)
        let old: FontItem | undefined
        try { old = stored ? JSON.parse(stored.font_json) : undefined } catch { /* Replace malformed display history, never manufacture proof. */ }
        if (identity(old) !== identity(item)) generations.set(key, (generations.get(key) || 0) + 1)
        const recoveryContentHash = identity(old) === identity(item) ? old?.recoveryContentHash : undefined
        const json = snapshotJson(item, recoveryContentHash, old?.recoveryFileStamp)
        // A view read commonly remembers the same live row more than once.
        // Keep the existing transaction/read authority without issuing a row
        // write for byte-identical display history.
        if (stored?.font_json !== json) { write.run(key, json); counts.written++ }
      }
    })()
    return counts
  }
  async function capture(items: FontItem[], signal?: AbortSignal, alreadyRemembered = false): Promise<void> {
    if (!alreadyRemembered) remember(items)
    for (const item of items) {
      if (!open() || signal?.aborted) return
      if (item.fileAvailability === 'missing' || item.fileAvailability === 'unavailable') continue
      const key = normalizePathForCacheCompare(item.path), generation = generations.get(key)
      const old = previous(item.path)
      try {
        const { stamp } = await readFontIdentityMetadata(item.path)
        if (old?.recoveryContentHash && old.recoveryFileStamp === stamp) continue
        const evidence = await readFontContentIdentity(item.path)
        if (!open() || signal?.aborted || generation !== generations.get(key)) continue
        if (evidence.size !== item.fileSize || evidence.modified !== item.modifiedAt) continue
        const current = previous(item.path)
        if (!current || identity(current) !== identity(item)) continue
        write.run(key, snapshotJson(current, evidence.sha256, evidence.stamp))
      } catch (error) {
        // Retain the optional evidence owner until an aborted/timed-out child
        // has physically closed. Failed reads never replace proven history.
        await (error as { closed?: Promise<void> } | undefined)?.closed
      }
    }
  }
  function settleIdle(): void {
    if (draining || pending.size) return
    for (const resolve of idleWaiters) resolve()
    idleWaiters.clear()
  }
  function stopPending(): void { pending.clear(); active?.controller.abort(); settleIdle() }
  const unsubscribe = onApplicationClosing(stopPending)
  function schedule(items: FontItem[], log?: (message: string) => void): { queued: number; coalesced: number; historyWrites: number } {
    const result = { queued: 0, coalesced: 0, historyWrites: remember(items).written }
    if (log) backgroundLog = log
    if (!open() || isApplicationClosing()) return result
    for (const item of items) {
      if (!item.path || item.fileAvailability === 'missing' || item.fileAvailability === 'unavailable') continue
      const key = normalizePathForCacheCompare(item.path)
      if (active?.key === key && identity(active.item) === identity(item)) { result.coalesced++; continue }
      if (pending.has(key)) result.coalesced++; else result.queued++
      pending.set(key, { item: { ...item }, generation: generations.get(key) })
    }
    startDrain()
    return result
  }
  function startDrain(): void {
    if (draining || foregroundReaders || !pending.size || !open() || isApplicationClosing()) return
    const log = (message: string) => { try { backgroundLog?.(message) } catch { /* Observation cannot own recovery work. */ } }
    const startedAt = Date.now()
    let captured = 0
    draining = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
      while (open() && !isApplicationClosing() && !foregroundReaders && pending.size) {
        const [key, queued] = pending.entries().next().value!
        pending.delete(key)
        const { item } = queued
        if (queued.generation !== generations.get(key) || identity(previous(item.path)) !== identity(item)) continue
        const controller = new AbortController()
        active = { key, item, controller }
        await withSharedIoPriority('background', () => withSharedIoSignal(controller.signal, () => capture([item], controller.signal, true)))
        if (!controller.signal.aborted) captured++
        active = undefined
      }
    }).catch(error => log(`tag recovery evidence capture stopped: ${String(error).slice(0, 180)}`)).finally(() => {
      active = undefined; draining = undefined
      if (!open() || isApplicationClosing()) pending.clear()
      log(`tag recovery evidence background settled: examined=${captured}, pending=${pending.size}, elapsedMs=${Date.now() - startedAt}, closed=${!open()}`)
      startDrain()
      settleIdle()
    })
  }
  function holdBackgroundCapture(): () => void {
    if (!open() || isApplicationClosing()) return () => undefined
    foregroundReaders++
    let released = false
    return () => {
      if (released) return
      released = true; foregroundReaders--
      // A running child is never cancelled by a view lease. Only the next
      // queued item is deferred; the final reader resumes one timer-based drain.
      if (!foregroundReaders) startDrain()
    }
  }
  return {
    read: previous, remember, capture, schedule, holdBackgroundCapture,
    whenIdle: (): Promise<void> => !draining && !pending.size ? Promise.resolve() : new Promise(resolve => idleWaiters.add(resolve)),
    dispose: () => { disposed = true; stopPending(); unsubscribe() },
  }
}
