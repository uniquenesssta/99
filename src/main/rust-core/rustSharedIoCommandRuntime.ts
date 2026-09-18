import { win32 } from 'node:path'
import { mappedDriveTableAsync, normalizeNativePathText } from '../path/pathCanonicalizer'
import { SharedIoProcessError } from '../path/sharedIoProcessRuntime'

export type RustSharedIoTarget = { paths: string[]; write: boolean }

// Identity is lexical. Never stat/realpath a network path on the main thread.
export async function sharedIoResourceKeys(paths: string[]): Promise<string[]> {
  const normalized = paths.filter(Boolean).map(normalizeNativePathText)
  const needsMapping = process.platform === 'win32' && normalized.some(path => /^[a-z]:/i.test(path))
  const mapping = needsMapping ? await mappedDriveTableAsync() : new Map<string, string>()
  if (mapping === null) throw new SharedIoProcessError('Shared I/O drive identity unavailable', 'not-started', 'identity-unavailable')
  const keys = new Set<string>()
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
