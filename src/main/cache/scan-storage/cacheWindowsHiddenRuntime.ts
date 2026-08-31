import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ScanCacheStorageRuntimeOptions } from './scanCacheStorageTypes'

const execFileAsync = promisify(execFile)

export function createCacheWindowsHiddenRuntime(options: Pick<ScanCacheStorageRuntimeOptions, 'appendStartupLog'>) {
  async function hideDirectoryOnWindows(dir: string): Promise<void> {
    if (process.platform !== 'win32') return
    try {
      await execFileAsync('attrib', ['+h', dir])
    } catch (error) {
      options.appendStartupLog(`cache hide failed: ${dir} ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { hideDirectoryOnWindows }
}
