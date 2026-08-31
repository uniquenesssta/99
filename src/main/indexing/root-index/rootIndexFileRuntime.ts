import { promises as fsp } from 'node:fs'
import { basename,dirname,extname,isAbsolute,join,relative,resolve } from 'node:path'
import { ROOT_CACHE_MANIFEST_FILE_NAME,ROOT_INDEX_DB_DIR_NAME } from '../../cache/constants'
import { normalizePathForCacheCompare } from '../../path/cachePath'

export function rootCacheManifestPath(cacheDir: string): string {
  return join(cacheDir, ROOT_CACHE_MANIFEST_FILE_NAME)
}

export function rootCacheIdentityPath(cacheDir: string): string {
  return join(cacheDir, 'identity.json')
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const json = JSON.stringify(value)
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  async function writeTemp(): Promise<void> {
    await fsp.mkdir(dirname(tempPath), { recursive: true })
    await fsp.writeFile(tempPath, json, 'utf-8')
  }
  async function renameTemp(): Promise<void> {
    try {
      await fsp.rename(tempPath, filePath)
    } catch (error: any) {
      if (error?.code === 'EEXIST' || error?.code === 'EPERM' || error?.code === 'EACCES') {
        await fsp.rm(filePath, { force: true }).catch(() => undefined)
        await fsp.rename(tempPath, filePath)
        return
      }
      throw error
    }
  }

  await writeTemp()
  try {
    await renameTemp()
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      await fsp.rm(tempPath, { force: true }).catch(() => undefined)
      await writeTemp()
      await renameTemp()
      return
    }
    await fsp.rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}


export function relativeCachePath(cacheDir: string, filePath: string): string {
  const rel = relative(cacheDir, filePath).replaceAll('\\', '/')
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : `${ROOT_INDEX_DB_DIR_NAME}/${basename(filePath)}`
}

export function safeManifestDatabasePath(cacheDir: string, relativeDatabasePath?: string): string | null {
  if (!relativeDatabasePath) return null
  const clean = String(relativeDatabasePath).replaceAll('\\', '/').replace(/^\/+/, '')
  if (!clean || clean.includes('..') || extname(clean).toLowerCase() !== '.sqlite') return null
  const resolved = resolve(cacheDir, ...clean.split('/').filter(Boolean))
  const normalizedCacheDir = normalizePathForCacheCompare(resolve(cacheDir))
  const normalizedResolved = normalizePathForCacheCompare(resolved)
  if (normalizedResolved !== normalizedCacheDir && !normalizedResolved.startsWith(`${normalizedCacheDir}\\`)) return null
  return resolved
}
