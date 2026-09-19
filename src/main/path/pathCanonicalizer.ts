import { execFile } from 'node:child_process'

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

function parseMappedDriveTable(stdout: string): Map<string, string> {
  const drives = new Map<string, string>()
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const driveMatch = line.match(/\b([a-zA-Z]:)(?=\s|$)/)
    const uncIndex = line.indexOf('\\\\')
    if (!driveMatch || uncIndex < 0) continue
    const remote = line.slice(uncIndex).trim().split(/\s{2,}/)[0]
    if (!/^\\\\[^\\]+\\[^\\]+/.test(remote)) continue
    drives.set(driveMatch[1].toUpperCase(), normalizeNativePathText(remote))
  }
  return drives
}

let mappedDriveFailureUntil = 0
let mappedDriveTableInFlight: Promise<Map<string, string> | null> | null = null

// The availability owner must never perform the synchronous legacy mapping lookup.
export async function mappedDriveTableAsync(): Promise<Map<string, string> | null> {
  if (process.platform !== 'win32') return new Map()
  if (mappedDriveTableInFlight) return mappedDriveTableInFlight
  if (mappedDriveFailureUntil > Date.now()) return null
  if (mappedDriveTableCache && mappedDriveTableCache.expiresAt > Date.now()) return new Map(mappedDriveTableCache.drives)
  mappedDriveTableInFlight = new Promise<Map<string, string> | null>((done) => {
    execFile('net.exe', ['use'], { encoding: 'utf8', timeout: 1500, windowsHide: true, shell: false }, (error, stdout) => {
      if (error) { mappedDriveFailureUntil = Date.now() + 5000; done(null); return }
      const drives = parseMappedDriveTable(String(stdout || ''))
      mappedDriveTableCache = { drives, expiresAt: Date.now() + MAPPED_DRIVE_TABLE_TTL_MS }
      done(new Map(drives))
    })
  })
  try { return await mappedDriveTableInFlight } finally { mappedDriveTableInFlight = null }
}

export function mappedDriveTable(): Map<string, string> {
  if (!mappedDriveTableCache || mappedDriveTableCache.expiresAt <= Date.now()) void mappedDriveTableAsync().catch(() => undefined)
  return new Map(mappedDriveTableCache?.drives || [])
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
