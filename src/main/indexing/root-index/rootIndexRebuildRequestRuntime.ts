import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { writeJsonAtomic } from './rootIndexFileRuntime'

const requestPath = (cacheDir: string) => join(cacheDir, 'index-rebuild-request.json')

// The build/index locks belong to the caller. Keep the active DB and pointer
// readable until a complete replacement has crossed the activation commit.
export async function requestRootIndexRebuild(cacheDir: string): Promise<string> {
  const id = randomUUID()
  await writeJsonAtomic(requestPath(cacheDir), { id })
  return id
}

export async function readRootIndexRebuildRequest(cacheDir: string): Promise<string | undefined> {
  let raw: string
  try { raw = await fsp.readFile(requestPath(cacheDir), 'utf-8') }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined
    throw error // Offline, denied and deferred reads are not absence.
  }
  const request = JSON.parse(raw) as { id?: unknown }
  if (typeof request.id !== 'string' || !request.id) throw new Error('索引重建请求无效，已保留现有索引。')
  return request.id
}

export async function acknowledgeRootIndexRebuild(cacheDir: string, id?: string): Promise<void> {
  if (!id || await readRootIndexRebuildRequest(cacheDir) !== id) return
  await fsp.rm(requestPath(cacheDir))
}
