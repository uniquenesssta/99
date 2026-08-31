import { promises as fsp } from 'node:fs'
import type { FontScanCacheFile } from '../indexing/rootIndexRuntime'
import type { FolderCacheRuntimeDeps } from './folderCacheTypes'

export function createFolderCacheJsonRuntime(deps: Pick<FolderCacheRuntimeDeps, 'fontScanCacheVersion' | 'exists'>) {
  async function readScanCacheFile(filePath: string): Promise<FontScanCacheFile> {
    try {
      const raw = await fsp.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as FontScanCacheFile
      if (parsed.version !== deps.fontScanCacheVersion || !parsed.entries) {
        throw new Error('bad cache')
      }
      return parsed
    } catch {
      return { version: deps.fontScanCacheVersion, entries: {} }
    }
  }

  async function readExistingScanCacheFile(filePath: string): Promise<FontScanCacheFile | null> {
    if (!(await deps.exists(filePath))) return null
    return readScanCacheFile(filePath)
  }

  return { readExistingScanCacheFile, readScanCacheFile }
}
