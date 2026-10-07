import { dirname, win32 } from 'node:path'
import { mappedDriveTableAsync, normalizeNativePathText } from '../path/pathCanonicalizer'
import { SharedIoProcessError } from '../path/sharedIoProcessRuntime'

import type { SharedIoAccess, SharedIoAccessPath } from '../path/sharedIoAccessRuntime'

export type RustSharedIoTarget = { paths: string[]; write: boolean; accesses?: SharedIoAccessPath[]; preview?: boolean }

const configuredRoots = new Map<string, { resource: string; physical?: string }>()
export function registerIsolatedRoot(rootPath: string, physicalPath?: string): void {
  if (process.platform !== 'win32') return
  const root = win32.normalize(normalizeNativePathText(rootPath)).toLowerCase().replace(/\\+$/, '')
  const previousEntry = configuredRoots.get(root)
  const previous = previousEntry?.resource
  if (!physicalPath) {
    if (!previous) configuredRoots.set(root, { resource: `configured-root:${root}` })
    return
  }
  const physical = win32.normalize(normalizeNativePathText(physicalPath)).toLowerCase()
  const share = physical.match(/^\\\\[^\\]+\\[^\\]+/)
  if (previousEntry?.physical && share && previousEntry.physical !== physical.replace(/\\+$/, '')) throw new SharedIoProcessError('共享根物理路径已变化。', 'not-started', 'identity-changed')
  const resource = share?.[0] || `configured-root:${root}`
  if (previous?.startsWith('\\\\') && resource.startsWith('\\\\') && previous !== resource)
    throw new SharedIoProcessError('共享根物理身份已变化。', 'not-started', 'identity-changed')
  // An unverified lexical registration must never downgrade a previously
  // verified UNC identity. Only a newly verified different UNC share is a
  // physical identity change.
  if (!previous?.startsWith('\\\\') || resource.startsWith('\\\\')) configuredRoots.set(root, { resource, physical: share ? physical.replace(/\\+$/, '') : undefined })
}

// Transport-owned exclusion snapshot; never supplied by a renderer request.
export function configuredSharedIoRoots(): string[] {
  return [...new Set([...configuredRoots].flatMap(([root, value]) => value.physical ? [root, value.physical] : [root]))]
}

export function sharedIoAvailabilityRoot(path: string): string | undefined {
  const normalized = win32.normalize(normalizeNativePathText(path))
  const match = [...configuredRoots.keys()].filter(root => normalized.toLowerCase() === root || normalized.toLowerCase().startsWith(root + '\\')).sort((a,b) => b.length-a.length)[0]
  return match || normalized.match(/^\\\\[^\\]+\\[^\\]+/)?.[0] || (/^[a-z]:\\/i.test(normalized) ? normalized.slice(0,3) : undefined)
}

// Identity is lexical. Never stat/realpath a network path on the main thread.
export async function sharedIoResourceKeys(paths: string[]): Promise<string[]> {
  const systemDrive = String(process.env.SystemDrive || '').toUpperCase()
  const keys = new Set<string>()
  const normalized = paths.filter(Boolean).map(normalizeNativePathText)
    .filter(path => {
      const canonical = win32.normalize(path).toLowerCase()
      const match = [...configuredRoots].filter(([root]) => canonical === root || canonical.startsWith(root + '\\')).sort((a, b) => b[0].length - a[0].length)[0]
      if (match) { keys.add(match[1].resource); return false }
      return true
    })
    .filter(path => !systemDrive || path.slice(0, 2).toUpperCase() !== systemDrive)
  const needsMapping = process.platform === 'win32' && normalized.some(path => /^[a-z]:/i.test(path))
  const mapping = needsMapping ? await mappedDriveTableAsync() : new Map<string, string>()
  if (mapping === null) throw new SharedIoProcessError('Shared I/O drive identity unavailable', 'not-started', 'identity-unavailable')
  for (let path of normalized) {
    const drive = path.match(/^([a-z]:)(\\.*)?$/i)
    if (drive) {
      const remote = mapping.get(drive[1].toUpperCase())
      if (remote) path = remote + (drive[2] || '')
    }
    const canonical = win32.normalize(path).toLowerCase()
    const share = canonical.match(/^\\\\[^\\]+\\[^\\]+/)
    if (share) keys.add(share[0])
  }
  return [...keys].sort()
}

// Inputs are snapshots owned by the transport, never a file read from the share.
export function sharedIoPathsInInput(value: unknown): string[] {
  const paths = new Set<string>()
  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      if (/^(?:[a-z]:[\\/]|[\\/]{2})/i.test(item)) paths.add(item)
    } else if (Array.isArray(item)) item.forEach(visit)
    else if (item && typeof item === 'object') Object.values(item).forEach(visit)
  }
  visit(value)
  return [...paths]
}

// Only verified root translations and the existing mapping owner can resolve aliases.
// Unverified configured roots deliberately keep their conservative share barrier.
export async function sharedIoAccesses(paths: SharedIoAccessPath[]): Promise<SharedIoAccess[] | undefined> {
  const result: SharedIoAccess[] = []
  for (const access of paths) {
    if (!access.path) continue
    const roots = await sharedIoResourceKeys([access.path])
    if (!roots.length) continue
    let path = win32.normalize(normalizeNativePathText(access.path)).toLowerCase().replace(/\\+$/, '')
    const registered = [...configuredRoots].filter(([root]) => path === root || path.startsWith(root + '\\')).sort((a,b) => b[0].length-a[0].length)[0]
    if (registered) {
      if (!registered[1].physical) return undefined
      path = registered[1].physical + path.slice(registered[0].length)
    } else if (/^[a-z]:/i.test(path)) {
      const mapping = await mappedDriveTableAsync()
      const remote = mapping?.get(path.slice(0,2).toUpperCase())
      if (!remote) return undefined
      path = win32.normalize(remote + path.slice(2)).toLowerCase()
    }
    if (!path.startsWith('\\\\') || roots.length !== 1) return undefined
    result.push({ ...access, path, root: roots[0] })
  }
  return [...new Map(result.map(access => [JSON.stringify(access), access])).values()].sort((a,b) => a.path.localeCompare(b.path))
}

/** For DB commands whose only filesystem side effect is preparing the DB parent. */
export function sharedDatabaseTarget(dbPath: string, write: boolean, checkedRoots: string[] = []): RustSharedIoTarget {
  if (!dbPath) return { paths: checkedRoots.filter(Boolean), write }
  const accesses: SharedIoAccessPath[] = [{ path: dbPath, mode: write ? 'write' : 'read', scope: 'database' }]
  if (write) accesses.push({ path: win32.isAbsolute(dbPath) ? win32.dirname(dbPath) : dirname(dbPath), mode: 'write', scope: 'file' })
  for (const path of checkedRoots.filter(Boolean)) accesses.push({ path, mode: 'read', scope: 'file' })
  return { paths: accesses.map(access => access.path), accesses, write }
}
