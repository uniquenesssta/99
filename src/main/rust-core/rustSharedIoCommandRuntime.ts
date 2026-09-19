import { win32 } from 'node:path'
import { mappedDriveTableAsync, normalizeNativePathText } from '../path/pathCanonicalizer'
import { SharedIoProcessError } from '../path/sharedIoProcessRuntime'

export type RustSharedIoTarget = { paths: string[]; write: boolean }

const configuredRoots = new Map<string, string>()
export function registerIsolatedRoot(rootPath: string, physicalPath?: string): void {
  if (process.platform !== 'win32') return
  const root = win32.normalize(normalizeNativePathText(rootPath)).toLowerCase().replace(/\\+$/, '')
  const physical = physicalPath ? win32.normalize(normalizeNativePathText(physicalPath)).toLowerCase() : ''
  const share = physical.match(/^\\\\[^\\]+\\[^\\]+/)
  const resource = share?.[0] || `configured-root:${root}`
  const previous = configuredRoots.get(root)
  if (previous?.startsWith('\\\\') && previous !== resource) throw new SharedIoProcessError('共享根物理身份已变化。', 'not-started', 'identity-changed')
  if (!previous || physicalPath) configuredRoots.set(root, resource)
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
      if (match) { keys.add(match[1]); return false }
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
