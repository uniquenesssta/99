import { promises as fsp } from 'node:fs'
import { createSharedIoProcessRuntime } from './sharedIoProcessRuntime'

const probes = createSharedIoProcessRuntime(() => undefined)
// This read-only probe uses the existing Electron executable in Node mode.
// Passing the path as an argv value keeps user path text out of executable code.
const probeSource = "try { const s = require('node:fs').statSync(process.argv[1]); process.stdout.write(s.isDirectory() ? 'directory' : 'file') } catch { process.exitCode = 1 }"

export async function probeStartupDirectory(rootPath: string, rootId: string, timeoutMs: number): Promise<boolean> {
  if (process.platform !== 'win32' && !/^(?:\\\\|\/\/)/.test(rootPath)) return (await fsp.stat(rootPath)).isDirectory()
  const result = await probes.run({ file: process.execPath, args: ['-e', probeSource, rootPath],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, roots: [rootId],
    timeoutMs, queueTimeoutMs: timeoutMs, maxBuffer: 1024, write: false })
  return result.stdout === 'directory'
}

export function stopSharedPathProbes(): void { probes.stop() }
