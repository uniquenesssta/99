import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { win32 } from 'node:path'
import { performance } from 'node:perf_hooks'
import { SharedIoProcessError } from '../path/sharedIoProcessRuntime'

type Proof = { version: 1; token: string; basePath: string; directoryPath: string; outputPath: string }
type Reservation = { basePath: string; token: string; excludedRoots: string[] }
const marker = 'hfm-owned-preview-ready: '
const key = (value: string) => win32.normalize(value).toLowerCase().replace(/\\+$/, '')
const within = (value: string, root: string) => key(value) === key(root) || key(value).startsWith(key(root) + '\\')
function localSystemPath(value: unknown, drive: string): value is string {
  return typeof value === 'string' && /^[a-z]:\\/i.test(value) && value.length <= 2048
    && value.slice(0, 2).toLowerCase() === drive.toLowerCase() && !value.slice(2).includes(':') && !value.includes('\0')
    && !value.split('\\').slice(1).some(part => part === '.' || part === '..' || /[. ]$/.test(part))
}

/** Native command semantics, not caller claims, guarantee no shared writes.
 * A reservation does not authorize filesystem cleanup until its native receipt.
 */
export function createNativeOwnedPreviewStageRuntime(resourceKeys: (paths: string[]) => Promise<string[]>, configuredRoots: () => string[]) {
  const live = new Map<string, ReturnType<typeof create>>()
  function create(request: Reservation, drive: string, workerPath: string, fontPath: string) {
    const logicalPath = win32.join(request.basePath, `.hfm-preview-stage-${request.token}`, 'preview.png')
    const openedAt = performance.now()
    let prepared: Proof | undefined
    const invalid = () => new SharedIoProcessError('Owned preview stage receipt invalid', 'unknown', 'invalid-stage-receipt')
    function validate(value: unknown): Proof {
      if (!value || typeof value !== 'object') throw invalid()
      const proof = value as Proof
      if (Object.keys(proof).sort().join('|') !== 'basePath|directoryPath|outputPath|token|version'
        || proof.version !== 1 || proof.token !== request.token || !localSystemPath(proof.basePath, drive)
        || !localSystemPath(proof.directoryPath, drive) || !localSystemPath(proof.outputPath, drive)
        || request.excludedRoots.some(root => within(proof.basePath, root))
        || key(proof.directoryPath) !== key(win32.join(proof.basePath, `.hfm-preview-stage-${request.token}`))
        || key(proof.outputPath) !== key(win32.join(proof.directoryPath, 'preview.png'))) throw invalid()
      return { ...proof }
    }
    return {
      request, logicalPath, workerPath, fontPath,
      get path() { return prepared?.outputPath || logicalPath },
      proof: { mode: 'native' as const, id: request.token, base: request.basePath, openedAt, joinedAt: openedAt },
      acceptLine(line: string): boolean {
        if (!line.startsWith(marker)) return false
        if (prepared) throw invalid()
        prepared = validate(JSON.parse(line.slice(marker.length)))
        return true
      },
      acceptFinal(value: unknown, output: unknown): void {
        const proof = validate(value)
        if (!prepared || output !== prepared.outputPath || Object.keys(prepared).some(field => proof[field as keyof Proof] !== prepared![field as keyof Proof])) throw invalid()
      },
      async dispose(): Promise<void> {
        live.delete(request.token)
        // Unknown/killed-before-ready ownership is retained, never guessed.
        if (!prepared) return
        await fsp.rm(prepared.outputPath, { force: true })
        await fsp.rmdir(prepared.directoryPath)
      },
    }
  }
  async function reserve(fontPath: string, workerPath: string) {
    if (process.platform !== 'win32' || !(await resourceKeys([fontPath])).length) return null
    const drive = String(process.env.SystemDrive || '')
    const basePath = tmpdir()
    const excludedRoots = [...configuredRoots()]
    if (!/^[a-z]:$/i.test(drive) || !localSystemPath(basePath, drive) || (await resourceKeys([basePath])).length || excludedRoots.length > 1024) return null
    const request = { basePath, token: randomUUID(), excludedRoots }
    Object.freeze(request.excludedRoots); Object.freeze(request)
    if (live.has(request.token)) throw new SharedIoProcessError('Owned stage reservation collision', 'not-started', 'invalid-stage-reservation')
    const stage = create(request, drive, workerPath, fontPath)
    live.set(request.token, stage)
    return stage
  }
  function forInput(input: unknown, workerPath: string) {
    if (!input || typeof input !== 'object') return undefined
    const value = input as { fontPath?: unknown; outputPath?: unknown; ownedStage?: Reservation }
    const stage = value.ownedStage && live.get(value.ownedStage.token)
    if (!stage || stage.workerPath !== workerPath || value.fontPath !== stage.fontPath || value.outputPath !== stage.logicalPath || JSON.stringify(value.ownedStage) !== JSON.stringify(stage.request)) return undefined
    return stage
  }
  return { reserve, forInput }
}
