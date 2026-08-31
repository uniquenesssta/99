import { promises as fsp } from 'node:fs'
import { dirname } from 'node:path'
import type { FontScanCacheFile } from '../../indexing/rootIndexRuntime'
import { isRootIndexDbPath } from '../cachePaths'
import { writeJsonAtomic } from '../jsonAtomic'
import type { RootIndexStorage,ScanCacheStorageRuntimeOptions } from './scanCacheStorageTypes'

export function createScanCacheJsonRuntime(options: ScanCacheStorageRuntimeOptions) {
  async function readScanCacheFile(filePath: string): Promise<FontScanCacheFile> {
    try {
      const raw = await fsp.readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as FontScanCacheFile
      if (parsed.version !== options.fontScanCacheVersion || !parsed.entries) throw new Error('bad cache')
      return parsed
    } catch {
      return { version: options.fontScanCacheVersion, entries: {} }
    }
  }

  async function readExistingScanCacheFile(filePath: string): Promise<FontScanCacheFile | null> {
    if (!(await options.exists(filePath))) return null
    return readScanCacheFile(filePath)
  }

  async function saveScanCacheFile(
    filePath: string,
    cache: FontScanCacheFile,
    rootPath?: string,
    storage: RootIndexStorage = 'root'
  ): Promise<void> {
    if (isRootIndexDbPath(filePath)) {
      await options.saveRootIndexSqliteFile(filePath, rootPath || dirname(dirname(filePath)), storage, cache)
      return
    }

    await options.withRootCacheWriteLock(filePath, async () => {
      await writeJsonAtomic(filePath, cache)
    })
  }

  return {
    readScanCacheFile,
    readExistingScanCacheFile,
    saveScanCacheFile
  }
}
