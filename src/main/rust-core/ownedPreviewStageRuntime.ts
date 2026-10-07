import { promises as fsp } from 'node:fs'
import { probeStartupDirectory } from '../path/sharedPathProbeRuntime'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'
import type { SharedIoAccessPath } from '../path/sharedIoAccessRuntime'

/** Only this owner may prove that a render's sole write is an unshared local stage. */
export function createOwnedPreviewStageRuntime(resourceKeys: (paths: string[]) => Promise<string[]>) {
  const live = new Set<string>()
  const localSystemPath = (path: string) => {
    const drive = process.env.SystemDrive
    return process.platform === 'win32' && /^[a-z]:$/i.test(drive || '') && /^[a-z]:\\/i.test(path)
      && path.slice(0, 2).toLowerCase() === drive!.toLowerCase()
  }
  async function allocate(fontPath: string, signal?: AbortSignal) {
    if (!(await resourceKeys([fontPath])).length) return null
    const base = tmpdir()
    // Do not realpath a possibly redirected/network temp directory on the main thread.
    if (!localSystemPath(base) || (await resourceKeys([base])).length) return null
    const probe = await probeStartupDirectory(base, 'preview-stage-locality', 500, { registerRoot: false, signal, label: 'preview-stage-locality' })
    const canonical = probe.physicalPath
    if (!probe.directory || !canonical || !localSystemPath(canonical) || (await resourceKeys([canonical])).length) return null
    const directory = await fsp.mkdtemp(win32.join(canonical, 'hfm-preview-stage-'))
    try {
      const resolved = await fsp.realpath(directory)
      if (!localSystemPath(resolved) || win32.dirname(resolved).toLowerCase() !== canonical.replace(/\\+$/, '').toLowerCase()
        || (await resourceKeys([resolved])).length) throw new Error('Preview stage locality could not be verified')
      const path = win32.join(resolved, 'preview.png')
      live.add(path)
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
  return { allocate, provesReadOnly }
}
