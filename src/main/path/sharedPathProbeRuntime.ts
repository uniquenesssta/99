import { promises as fsp } from 'node:fs'
import { applicationSharedIoProcessRuntime } from './sharedIoProcessRuntime'
import { rootProbeQueueTimeoutMs } from './ioDeadlineRuntime'
import { registerIsolatedRoot, sharedIoResourceKeys, sharedIoAccesses } from '../rust-core/rustSharedIoCommandRuntime'

const probes = applicationSharedIoProcessRuntime(() => undefined)
// Keep filesystem waits off this child's event loop so the parent-pipe guard
// stays responsive without starting a second JS runtime inside the 500ms budget.
// Only a fixed script is evaluated; paths are passed through argv.
const probeSource = `
const fs = require('node:fs');
const guard = new (require('node:net').Socket)({fd:3,readable:true,writable:false});
guard.on('end',()=>process.kill(process.pid));
guard.on('error',()=>process.kill(process.pid));
guard.resume(); guard.unref();
(async () => {
  try { const path = process.argv[1]; const stat = await fs.promises.stat(path);
    const physicalPath = await new Promise((resolve,reject)=>fs.realpath.native(path,(error,value)=>error?reject(error):resolve(value)));
    process.stdout.write(JSON.stringify({directory:stat.isDirectory(),physicalPath}));
  } catch { process.exitCode = 1; }
})();`

export type StartupDirectoryProbeResult = {
  directory: boolean
  physicalPath?: string
  queuedMs: number
  executionMs: number
}

export async function probeStartupDirectory(rootPath: string, rootId: string, timeoutMs: number, options: { registerRoot?: boolean; signal?: AbortSignal; label?: string; previewStageProof?: import('./sharedIoProcessRuntime').SharedIoProcessRequest['previewStageProof'] } = {}): Promise<StartupDirectoryProbeResult> {
  if (process.platform !== 'win32' && !/^(?:\\\\|\/\/)/.test(rootPath)) {
    const startedAt = Date.now()
    const stat = await fsp.stat(rootPath)
    return { directory: stat.isDirectory(), queuedMs: 0, executionMs: Date.now() - startedAt }
  }
  const keys = await sharedIoResourceKeys([rootPath])
  const result = await probes.run({ file: process.execPath, args: ['-e', probeSource, rootPath],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, roots: keys.length ? keys : [rootId], accesses: await sharedIoAccesses([{path: rootPath, mode: 'read', scope: 'file'}]),
    lane: 'root-probe', label: options.label, previewStageProof: options.previewStageProof, signal: options.signal, timeoutMs, queueTimeoutMs: rootProbeQueueTimeoutMs(), maxBuffer: 8192, write: false })
  const value = JSON.parse(result.stdout)
  if (typeof value.directory !== 'boolean' || typeof value.physicalPath !== 'string') throw new Error('Invalid directory probe receipt')
  if (value.directory && options.registerRoot !== false) registerIsolatedRoot(rootPath, value.physicalPath)
  return { directory: value.directory, physicalPath: value.physicalPath, queuedMs: result.queuedMs, executionMs: result.executionMs }
}

export function stopSharedPathProbes(): void { probes.stop() }
