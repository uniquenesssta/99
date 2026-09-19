import { promises as fsp } from 'node:fs'
import { applicationSharedIoProcessRuntime } from './sharedIoProcessRuntime'
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

export async function probeStartupDirectory(rootPath: string, rootId: string, timeoutMs: number): Promise<boolean> {
  if (process.platform !== 'win32' && !/^(?:\\\\|\/\/)/.test(rootPath)) return (await fsp.stat(rootPath)).isDirectory()
  const keys = await sharedIoResourceKeys([rootPath])
  const result = await probes.run({ file: process.execPath, args: ['-e', probeSource, rootPath],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, roots: keys.length ? keys : [rootId],
    timeoutMs, queueTimeoutMs: timeoutMs, maxBuffer: 8192, write: false })
  const value = JSON.parse(result.stdout)
  if (typeof value.directory !== 'boolean' || typeof value.physicalPath !== 'string') throw new Error('Invalid directory probe receipt')
  if (value.directory) registerIsolatedRoot(rootPath, value.physicalPath)
  return value.directory
}

export function stopSharedPathProbes(): void { probes.stop() }
