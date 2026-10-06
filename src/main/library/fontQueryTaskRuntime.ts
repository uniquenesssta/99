import { currentSharedIoSignal, withSharedIoSignal } from '../path/sharedFileSystemRuntime'
import { SharedIoProcessError } from '../path/sharedIoProcessRuntime'

export function assertFontQueryActive(signal = currentSharedIoSignal()): void {
  if (signal?.aborted) throw new SharedIoProcessError('字体查询已由当前视图替换。', 'not-started', 'query-superseded')
}
export function rethrowFontQuerySuperseded(error: unknown): void {
  assertFontQueryActive()
  if ((error as SharedIoProcessError)?.reason === 'query-superseded') throw error
}
export function fontQuerySuperseded(): never {
  throw new SharedIoProcessError('字体查询修订已变化。', 'not-started', 'query-superseded')
}
export type FontQueryTask<T> = { controller: AbortController; pending: Promise<T>; subscribers: number; settled: boolean }

// A physical read has its own signal. A subscriber leaving cannot cancel a
// shared read still needed by another view. Retain it through actual child close.
export function createFontQueryTask<T>(run: () => Promise<T>): FontQueryTask<T> {
  const controller = new AbortController()
  const task: FontQueryTask<T> = { controller, pending: undefined!, subscribers: 0, settled: false }
  task.pending = withSharedIoSignal(controller.signal, async () => {
    try { assertFontQueryActive(); return await run() }
    catch (error) { await (error as SharedIoProcessError)?.closed; throw error }
    finally { task.settled = true }
  })
  return task
}
export async function joinFontQueryTask<T>(task: FontQueryTask<T>, signal = currentSharedIoSignal()): Promise<T> {
  assertFontQueryActive(signal)
  task.subscribers++
  let release = () => undefined as void
  try {
    if (!signal) return await task.pending
    const cancelled = new Promise<never>((_, reject) => {
      const abort = () => reject(new SharedIoProcessError('字体查询视图已关闭。', 'not-started', 'query-superseded'))
      signal.addEventListener('abort', abort, { once: true })
      release = () => signal.removeEventListener('abort', abort)
      if (signal.aborted) abort()
    })
    return await Promise.race([task.pending, cancelled])
  } finally {
    release()
    task.subscribers--
    if (!task.subscribers && !task.settled) task.controller.abort()
  }
}

// Tokens are confined to the verified renderer sender by the IPC registrar.
export function createFontQueryConsumers() {
  const current = new Map<string, { token: string; controller: AbortController }>()
  const senders = new Map<number, () => void>()
  const cancelSender = (sender: number) => { for (const [key, entry] of current) if (key.startsWith(`${sender}:`)) entry.controller.abort() }
  function watch(sender: Electron.WebContents): void {
    if (senders.has(sender.id)) return
    const stop = () => cancelSender(sender.id)
    const navigation = (event: { isMainFrame: boolean; isSameDocument: boolean }) => { if (event.isMainFrame && !event.isSameDocument) stop() }
    sender.on('destroyed', stop); sender.on('render-process-gone', stop); sender.on('did-start-navigation', navigation)
    senders.set(sender.id, () => {
      sender.removeListener('destroyed', stop); sender.removeListener('render-process-gone', stop); sender.removeListener('did-start-navigation', navigation)
      senders.delete(sender.id)
    })
  }
  async function run<T>(sender: Electron.WebContents, kind: 'page' | 'metrics', token: unknown, read: () => Promise<T>): Promise<T> {
    if (typeof token !== 'string' || !token || token.length > 128) return read()
    if (sender.isDestroyed()) return fontQuerySuperseded()
    const key = `${sender.id}:${kind}`
    current.get(key)?.controller.abort()
    const entry = { token, controller: new AbortController() }
    current.set(key, entry); watch(sender)
    try { return await withSharedIoSignal(entry.controller.signal, async () => { assertFontQueryActive(); return read() }) }
    finally {
      if (current.get(key) === entry) current.delete(key)
      if (![...current.keys()].some(key => key.startsWith(`${sender.id}:`))) senders.get(sender.id)?.()
    }
  }
  function cancel(sender: number, token: unknown): void {
    for (const [key, entry] of current) if (key.startsWith(`${sender}:`) && entry.token === token) entry.controller.abort()
  }
  return { run, cancel }
}
