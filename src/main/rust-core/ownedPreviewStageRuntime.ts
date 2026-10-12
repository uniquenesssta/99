import { awaitPhysicalIoClose } from '../path/ioDeadlineRuntime'
import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { SharedIoProcessError } from '../path/sharedIoProcessRuntime'
import { probeStartupDirectory } from '../path/sharedPathProbeRuntime'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'
import type { SharedIoAccessPath } from '../path/sharedIoAccessRuntime'
import { currentPreviewRenderLifetime } from '../preview/runtime/previewRenderLifetimeRuntime'

/** Only this owner may prove that a render's sole write is an unshared local stage. */
export function createOwnedPreviewStageRuntime(resourceKeys: (paths: string[]) => Promise<string[]>) {
  type Proof = { id: string; base: string; openedAt: number; joinedAt?: number }
  const live = new Map<string, Proof>()
  const pending = new Map<string, { proof: Proof; promise: ReturnType<typeof probeStartupDirectory> }>()
  const checkSignal = (signal?: AbortSignal) => { if (signal?.aborted) throw new SharedIoProcessError('Preview staging cancelled', 'not-started', 'cancelled') }
  async function waitForProof(promise: ReturnType<typeof probeStartupDirectory>, signal?: AbortSignal, joinTimeoutMs?: number) {
    checkSignal(signal)
    if (!signal && joinTimeoutMs === undefined) return promise
    return new Promise<Awaited<typeof promise>>((resolve, reject) => {
      let settled = false, timer: ReturnType<typeof setTimeout> | undefined
      const finish = (action: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        action()
      }
      const abort = () => finish(() => reject(new SharedIoProcessError('Preview staging cancelled', 'not-started', 'cancelled')))
      signal?.addEventListener('abort', abort, { once: true })
      if (joinTimeoutMs !== undefined) timer = setTimeout(() => finish(() => reject(new SharedIoProcessError('Preview staging join queue budget exhausted', 'not-started', 'queue-timeout'))), joinTimeoutMs)
      promise.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
    })
  }
  const localSystemPath = (path: string) => {
    const drive = process.env.SystemDrive
    return process.platform === 'win32' && /^[a-z]:$/i.test(drive || '') && /^[a-z]:\\/i.test(path)
      && path.slice(0, 2).toLowerCase() === drive!.toLowerCase()
  }
  async function allocate(fontPath: string, signal?: AbortSignal) {
    const lifetime = currentPreviewRenderLifetime()
    lifetime?.assertCurrent()
    checkSignal(signal)
    if (!(await resourceKeys([fontPath])).length) return null
    const base = tmpdir()
    // Do not realpath a possibly redirected/network temp directory on the main thread.
    if (!localSystemPath(base) || (await resourceKeys([base])).length) return null
    checkSignal(signal)
    const key = `${win32.normalize(base).toLowerCase()}|${String(process.env.SystemDrive).toUpperCase()}`
    let entry = pending.get(key)
    // For an existing proof we cannot infer whether its child has left the
    // queue. Conservatively cap this subscriber's wait, never its shared owner.
    const joinTimeoutMs = entry ? lifetime?.queueTimeoutMs() : undefined
    if (!entry) {
      const proof: Proof = { id: randomUUID(), base, openedAt: performance.now() }
      // Proof is independently owned until physical close. A subscriber's
      // cancellation must never kill a proof that another subscriber still uses.
      const promise = probeStartupDirectory(base, 'preview-stage-locality', 500, { registerRoot: false, label: 'preview-stage-locality', previewStageProof: proof, queueTimeoutMs: lifetime?.queueTimeoutMs() })
        .catch(async error => { await awaitPhysicalIoClose(error); throw error })
      entry = { proof, promise }; pending.set(key, entry)
      const owner = entry
      void promise.finally(() => { if (pending.get(key) === owner) pending.delete(key) }).catch(() => undefined)
    }
    const joinedAt = performance.now()
    const chargeQueue = (timing: { queuedMs?: number; executionMs?: number }) => lifetime?.recordQueueWait(
      Math.max(0, Math.min(timing.queuedMs || 0, performance.now() - joinedAt - (timing.executionMs || 0))))
    const probe = await waitForProof(entry.promise, signal, joinTimeoutMs).then(result => { chargeQueue(result); return result }, error => { chargeQueue(error || {}); throw error })
    lifetime?.assertCurrent()
    checkSignal(signal)
    const canonical = probe.physicalPath
    if (!probe.directory || !canonical || !localSystemPath(canonical) || (await resourceKeys([canonical])).length) return null
    checkSignal(signal)
    lifetime?.assertCurrent()
    const directory = await fsp.mkdtemp(win32.join(canonical, 'hfm-preview-stage-'))
    try {
      const resolved = await fsp.realpath(directory)
      if (!localSystemPath(resolved) || win32.dirname(resolved).toLowerCase() !== canonical.replace(/\\+$/, '').toLowerCase()
        || (await resourceKeys([resolved])).length) throw new Error('Preview stage locality could not be verified')
      const path = win32.join(resolved, 'preview.png')
      lifetime?.assertCurrent()
      live.set(path, { ...entry.proof, base: canonical, joinedAt })
      return { path, dispose: async () => { live.delete(path); await fsp.rm(directory, { recursive: true, force: true }) } }
    } catch (error) {
      await fsp.rm(directory, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }
  function provesReadOnly(input: unknown, accesses?: SharedIoAccessPath[]): boolean {
    if (!input || typeof input !== 'object') return false
    const value = input as { fontPath?: unknown; outputPath?: unknown }
    return typeof value.fontPath === 'string' && typeof value.outputPath === 'string' && live.has(value.outputPath)
      && accesses?.length === 2 && accesses.some(a => a.path === value.fontPath && a.mode === 'read' && a.scope === 'file')
      && accesses.some(a => a.path === value.outputPath && a.mode === 'write' && a.scope === 'file')
  }
  const proofForInput = (input: unknown) => input && typeof input === 'object' ? live.get(String((input as { outputPath?: unknown }).outputPath || '')) : undefined
  return { allocate, provesReadOnly, proofForInput }
}
