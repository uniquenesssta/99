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
  const open = () => !disposed && db.open !== false && db.isOpen !== false
  const identity = (item?: FontItem) => item ? JSON.stringify([item.id, item.fileSize, item.modifiedAt]) : ''
  const previous = (path: string): FontItem | undefined => {
    if (!open()) return undefined
    try { const row = read.get(normalizePathForCacheCompare(path)); return row ? JSON.parse(row.font_json) : undefined } catch { return undefined }
  }
  function remember(items: FontItem[]): void {
    if (!open()) return
    db.transaction(() => {
      for (const item of items) {
        if (!item.path || item.fileAvailability === 'missing' || item.fileAvailability === 'unavailable') continue
        const key = normalizePathForCacheCompare(item.path)
        const old = previous(item.path)
        if (identity(old) !== identity(item)) generations.set(key, (generations.get(key) || 0) + 1)
        const { tagNames: _shared, localTagNames: _local, recoveryContentHash: _untrusted, recoveryFileStamp: _untrustedStamp, ...metadata } = item
        const recoveryContentHash = identity(old) === identity(item) ? old?.recoveryContentHash : undefined
        write.run(key, JSON.stringify({ ...metadata, recoveryContentHash, recoveryFileStamp: recoveryContentHash ? old?.recoveryFileStamp : undefined, tagNames: [], localTagNames: [] }))
      }
    })()
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
        write.run(key, JSON.stringify({ ...current, recoveryContentHash: evidence.sha256, recoveryFileStamp: evidence.stamp }))
      } catch { /* Failed/cancelled reads retain the last proven history, never guessed metadata. */ }
    }
  }
  function stopPending(): void { pending.clear(); active?.controller.abort() }
  const unsubscribe = onApplicationClosing(stopPending)
  function schedule(items: FontItem[], log?: (message: string) => void): void {
    remember(items)
    if (!open() || isApplicationClosing()) return
    for (const item of items) {
      if (!item.path || item.fileAvailability === 'missing' || item.fileAvailability === 'unavailable') continue
      const key = normalizePathForCacheCompare(item.path)
      if (active?.key === key && identity(active.item) === identity(item)) continue
      pending.set(key, { item: { ...item }, generation: generations.get(key) })
    }
    if (draining || !pending.size) return
    const startedAt = Date.now()
    let captured = 0
    draining = new Promise<void>(resolve => setTimeout(resolve, 0)).then(async () => {
      while (open() && !isApplicationClosing() && pending.size) {
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
    }).catch(error => log?.(`tag recovery evidence capture stopped: ${String(error).slice(0, 180)}`)).finally(() => {
      active = undefined; draining = undefined
      log?.(`tag recovery evidence background settled: examined=${captured}, pending=${pending.size}, elapsedMs=${Date.now() - startedAt}, closed=${!open()}`)
      if (pending.size && open() && !isApplicationClosing()) schedule([], log)
    })
  }
  return {
    read: previous, remember, capture, schedule,
    whenIdle: async () => { while (draining) await draining },
    dispose: () => { disposed = true; stopPending(); unsubscribe() },
  }
}
