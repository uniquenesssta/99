import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { SharedIoProcessError } from '../path/sharedIoProcessRuntime'
import { probeStartupDirectory } from '../path/sharedPathProbeRuntime'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'
import type { SharedIoAccessPath } from '../path/sharedIoAccessRuntime'

/** Only this owner may prove that a render's sole write is an unshared local stage. */
export function createOwnedPreviewStageRuntime(resourceKeys: (paths: string[]) => Promise<string[]>) {
  type Proof = { id: string; base: string; openedAt: number; joinedAt?: number }
  const live = new Map<string, Proof>()
  const pending = new Map<string, { proof: Proof; promise: ReturnType<typeof probeStartupDirectory> }>()
  const checkSignal = (signal?: AbortSignal) => { if (signal?.aborted) throw new SharedIoProcessError('Preview staging cancelled', 'not-started', 'cancelled') }
  async function waitForProof(promise: ReturnType<typeof probeStartupDirectory>, signal?: AbortSignal) {
    checkSignal(signal)
    if (!signal) return promise
    return new Promise<Awaited<typeof promise>>((resolve, reject) => {
      const abort = () => reject(new SharedIoProcessError('Preview staging cancelled', 'not-started', 'cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    })
  }
  const localSystemPath = (path: string) => {
    const drive = process.env.SystemDrive
    return process.platform === 'win32' && /^[a-z]:$/i.test(drive || '') && /^[a-z]:\\/i.test(path)
      && path.slice(0, 2).toLowerCase() === drive!.toLowerCase()
  }
  async function allocate(fontPath: string, signal?: AbortSignal) {
    checkSignal(signal)
    if (!(await resourceKeys([fontPath])).length) return null
    const base = tmpdir()
    // Do not realpath a possibly redirected/network temp directory on the main thread.
    if (!localSystemPath(base) || (await resourceKeys([base])).length) return null
    checkSignal(signal)
    const key = `${win32.normalize(base).toLowerCase()}|${String(process.env.SystemDrive).toUpperCase()}`
    let entry = pending.get(key)
    if (!entry) {
      const proof: Proof = { id: randomUUID(), base, openedAt: performance.now() }
      const promise = probeStartupDirectory(base, 'preview-stage-locality', 500, { registerRoot: false, label: 'preview-stage-locality', previewStageProof: proof })
        .catch(async error => { if (error instanceof SharedIoProcessError) await error.closed; throw error })
      entry = { proof, promise }; pending.set(key, entry)
      const owner = entry
      void promise.finally(() => { if (pending.get(key) === owner) pending.delete(key) }).catch(() => undefined)
    }
    const joinedAt = performance.now()
    const probe = await waitForProof(entry.promise, signal)
    checkSignal(signal)
    const canonical = probe.physicalPath
    if (!probe.directory || !canonical || !localSystemPath(canonical) || (await resourceKeys([canonical])).length) return null
    checkSignal(signal)
    const directory = await fsp.mkdtemp(win32.join(canonical, 'hfm-preview-stage-'))
    try {
      const resolved = await fsp.realpath(directory)
      if (!localSystemPath(resolved) || win32.dirname(resolved).toLowerCase() !== canonical.replace(/\\+$/, '').toLowerCase()
        || (await resourceKeys([resolved])).length) throw new Error('Preview stage locality could not be verified')
      const path = win32.join(resolved, 'preview.png')
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
