import { promises as fsp } from 'node:fs'
import { applicationSharedIoProcessRuntime } from './sharedIoProcessRuntime'
import { rootProbeQueueTimeoutMs } from './ioDeadlineRuntime'
import { registerIsolatedRoot, sharedIoResourceKeys } from '../rust-core/rustSharedIoCommandRuntime'

const probes = applicationSharedIoProcessRuntime(() => undefined)
// A separate JS worker watches the parent pipe even while stat/realpath blocks.
// Only a fixed script is evaluated; paths are passed through argv.
const probeSource = `
const { Worker } = require('node:worker_threads');
const guard = new Worker("const net = require('node:net'); const p = new net.Socket({fd:3,readable:true,writable:false}); p.on('end',()=>process.kill(process.pid)); p.on('error',()=>process.kill(process.pid)); p.resume();", {eval:true});
guard.once('online', () => {
  guard.unref();
  try { const fs = require('node:fs'); const path = process.argv[1]; const stat = fs.statSync(path);
    process.stdout.write(JSON.stringify({directory:stat.isDirectory(),physicalPath:fs.realpathSync.native(path)}));
  } catch { process.exitCode = 1; }
});`

export type StartupDirectoryProbeResult = {
  directory: boolean
  physicalPath?: string
  queuedMs: number
  executionMs: number
}

export async function probeStartupDirectory(rootPath: string, rootId: string, timeoutMs: number): Promise<StartupDirectoryProbeResult> {
  if (process.platform !== 'win32' && !/^(?:\\\\|\/\/)/.test(rootPath)) {
    const startedAt = Date.now()
    const stat = await fsp.stat(rootPath)
    return { directory: stat.isDirectory(), queuedMs: 0, executionMs: Date.now() - startedAt }
  }
  const keys = await sharedIoResourceKeys([rootPath])
  const result = await probes.run({ file: process.execPath, args: ['-e', probeSource, rootPath],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, roots: keys.length ? keys : [rootId],
    lane: 'root-probe', timeoutMs, queueTimeoutMs: rootProbeQueueTimeoutMs(), maxBuffer: 8192, write: false })
  const value = JSON.parse(result.stdout)
  if (typeof value.directory !== 'boolean' || typeof value.physicalPath !== 'string') throw new Error('Invalid directory probe receipt')
  if (value.directory) registerIsolatedRoot(rootPath, value.physicalPath)
  return { directory: value.directory, physicalPath: value.physicalPath, queuedMs: result.queuedMs, executionMs: result.executionMs }
}

export function stopSharedPathProbes(): void { probes.stop() }
