import { execFileSync } from 'node:child_process'

export type PathCanonicalizerLogger = (message: string) => void

type MappedDriveTableCache = {
  expiresAt: number
  drives: Map<string, string>
}

const MAPPED_DRIVE_TABLE_TTL_MS = 30000
let mappedDriveTableCache: MappedDriveTableCache | null = null
const loggedMappedDriveCanonicalizations = new Set<string>()

export function normalizeNativePathSeparators(filePath: string): string {
  return String(filePath || '').trim().replaceAll('/', '\\')
}

export function removeWindowsDevicePathPrefix(filePath: string): string {
  let value = normalizeNativePathSeparators(filePath)
  value = value.replace(/^\\\\\?\\UNC\\/i, '\\\\')
  value = value.replace(/^\\\\\?\\/i, '')
  return value
}

export function trimTrailingPathSeparators(filePath: string): string {
  const value = String(filePath || '')
  if (/^[a-zA-Z]:\\?$/.test(value)) return value.slice(0, 2) + '\\'
  if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(value)) return value.replace(/\\+$/g, '')
  return value.replace(/\\+$/g, '')
}

export function normalizeNativePathText(filePath: string): string {
  return trimTrailingPathSeparators(removeWindowsDevicePathPrefix(filePath))
}

export function normalizePathCompareText(filePath: string): string {
  return normalizeNativePathText(filePath).toLowerCase()
}

function readMappedDriveTableFromWindows(): Map<string, string> {
  const drives = new Map<string, string>()
  if (process.platform !== 'win32') return drives

  try {
    const stdout = execFileSync('cmd.exe', ['/d', '/s', '/c', 'net use'], {
      encoding: 'utf8',
      timeout: 1500,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    for (const line of String(stdout || '').split(/\r?\n/)) {
      const driveMatch = line.match(/\b([a-zA-Z]:)\b/)
      const uncIndex = line.indexOf('\\\\')
      if (!driveMatch || uncIndex < 0) continue
      const remoteMatch = line.slice(uncIndex).trim().match(/^(\\\\\S+)/)
      if (!remoteMatch) continue
      drives.set(driveMatch[1].toUpperCase(), normalizeNativePathText(remoteMatch[1]))
    }
  } catch {
    // Mapping lookup is best-effort. If it fails, keep the user's original path.
  }

  return drives
}

export function mappedDriveTable(): Map<string, string> {
  const now = Date.now()
  if (mappedDriveTableCache && mappedDriveTableCache.expiresAt > now) return mappedDriveTableCache.drives

  const drives = readMappedDriveTableFromWindows()
  mappedDriveTableCache = {
    expiresAt: now + MAPPED_DRIVE_TABLE_TTL_MS,
    drives,
  }
  return drives
}

export function mappedDriveToUncPath(filePath: string, appendLog?: PathCanonicalizerLogger): string {
  const normalized = normalizeNativePathText(filePath)
  const driveMatch = normalized.match(/^([a-zA-Z]:)(\\.*)?$/)
  if (!driveMatch) return normalized

  const drive = driveMatch[1].toUpperCase()
  const remoteRoot = mappedDriveTable().get(drive)
  if (!remoteRoot) return normalized

  const suffix = driveMatch[2] || ''
  const canonical = normalizeNativePathText(`${remoteRoot}${suffix}`)
  const logKey = `${drive}|${normalizePathCompareText(canonical)}`
  if (!loggedMappedDriveCanonicalizations.has(logKey)) {
    loggedMappedDriveCanonicalizations.add(logKey)
    appendLog?.(`mapped drive path canonicalized: ${normalized} -> ${canonical}`)
  }
  return canonical
}

export function canonicalizeWatchedFolderPathText(filePath: string, appendLog?: PathCanonicalizerLogger): string {
  return mappedDriveToUncPath(normalizeNativePathText(filePath), appendLog)
}
