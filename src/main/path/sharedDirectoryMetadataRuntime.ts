import type { CachedFontStatLike } from '../fonts/fontRuntime'
import { sharedIoResourceKeys } from '../rust-core/rustSharedIoCommandRuntime'
import { executeSharedFile } from './sharedFileSystemRuntime'
import { SharedIoProcessError } from './sharedIoProcessRuntime'

export type SharedDirectoryEntry = {
  name: string
  isFile: () => boolean
  isDirectory: () => boolean
  isSymbolicLink: () => boolean
  stat?: CachedFontStatLike
}

function invalid(): never {
  throw new SharedIoProcessError('共享目录文件状态回执不完整。', 'unknown', 'invalid-receipt')
}

function stat(value: unknown): CachedFontStatLike {
  const row = value as Record<string, unknown> | null
  if (!row || !['size', 'mtimeMs', 'birthtimeMs'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key])) || Number(row.size) < 0) invalid()
  return { size: row.size as number, mtimeMs: row.mtimeMs as number, birthtimeMs: row.birthtimeMs as number }
}

// One killable read per directory; no font contents and no guessed file times.
export async function readSharedDirectoryMetadata(path: string, signal?: AbortSignal): Promise<{
  stat: CachedFontStatLike
  entries: SharedDirectoryEntry[]
} | null> {
  if (!(await sharedIoResourceKeys([path])).length) return null
  const { result } = await executeSharedFile({ operation: 'directoryMetadata', path }, undefined, signal).catch(error => {
    if (error instanceof SharedIoProcessError) throw error
    throw Object.assign(new SharedIoProcessError('共享目录文件状态读取失败。', 'unknown', 'directory-read-failed'), { cause: error })
  })
  return parseDirectoryMetadata(result.value)
}
function parseDirectoryMetadata(value: any): { stat: CachedFontStatLike; entries: SharedDirectoryEntry[] } {
  if (!value || value.stat?.isDirectory !== true || !Array.isArray(value.entries)) invalid()
  const directory = stat(value.stat)
  const names = new Set<string>()
  const entries = value.entries.map((row: Record<string, unknown>): SharedDirectoryEntry => {
    if (!row || typeof row.name !== 'string' || !row.name || /[\\/\0]/.test(row.name) || row.name === '.' || row.name === '..' || names.has(row.name)) invalid()
    if (!['isFile', 'isDirectory', 'isSymbolicLink'].every(key => typeof row[key] === 'boolean')) invalid()
    if ([row.isFile, row.isDirectory, row.isSymbolicLink].filter(Boolean).length > 1) invalid()
    names.add(row.name)
    return { name: row.name, isFile: () => row.isFile === true, isDirectory: () => row.isDirectory === true,
      isSymbolicLink: () => row.isSymbolicLink === true, stat: row.isFile ? stat(row.stat) : undefined }
  })
  return { stat: directory, entries }
}

// Only the current scan owns these receipts. No polling/session cache can supply
// them; callers consume siblings immediately and discard them after this walk.
export async function readSharedDirectoryMetadataBatch(paths: string[], signal?: AbortSignal): Promise<Map<string, NonNullable<Awaited<ReturnType<typeof readSharedDirectoryMetadata>>>> | null> {
  if (!paths.length) return new Map()
  if (paths.length > 8) throw new Error('共享目录读取批次超过上限。')
  if (!(await sharedIoResourceKeys(paths)).length) return null
  const { result } = await executeSharedFile({ operation: 'directoryMetadataBatch', path: paths[0], paths }, undefined, signal)
  if (!Array.isArray(result.value) || result.value.length !== paths.length) invalid()
  const rows = new Map<string, NonNullable<Awaited<ReturnType<typeof readSharedDirectoryMetadata>>>>()
  result.value.forEach((row: any, index: number) => {
    if (row?.path !== paths[index] || rows.has(row.path)) invalid()
    rows.set(row.path, parseDirectoryMetadata(row.value))
  })
  return rows
}
