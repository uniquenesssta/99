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

// Query local WMI; never parse localized `net use` columns or OEM bytes.
// ASCII output preserves Unicode paths regardless of the console code page.
const MAPPED_DRIVE_QUERY = `$ErrorActionPreference = 'Stop'
$rows = @(Get-CimInstance -Query 'SELECT DeviceID, ProviderName FROM Win32_LogicalDisk WHERE DriveType = 4' | ForEach-Object { @{ drive = [string]$_.DeviceID; remote = [string]$_.ProviderName } })
$json = ConvertTo-Json -InputObject $rows -Compress
[Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))`

function parseMappedDriveTable(stdout: string): Map<string, string> {
  const encoded = stdout.trim()
  const bytes = Buffer.from(encoded, 'base64')
  if (!encoded || bytes.toString('base64') !== encoded) throw new Error('Invalid mapped drive response')
  const rows: unknown = JSON.parse(bytes.toString('utf8'))
  if (!Array.isArray(rows)) throw new Error('Invalid mapped drive table')
  const drives = new Map<string, string>()
  for (const row of rows) {
    if (!row || typeof row.drive !== 'string' || !/^[a-z]:$/i.test(row.drive)
      || typeof row.remote !== 'string' || /[\u0000-\u001f\ufffd]/.test(row.remote)) throw new Error('Invalid mapped drive identity')
    const remote = normalizeNativePathText(row.remote)
    if (!/^\\\\[^\\]+\\[^\\]+/.test(remote)) throw new Error('Invalid mapped drive remote path')
    const drive = row.drive.toUpperCase()
    if (drives.has(drive)) throw new Error('Duplicate mapped drive identity')
    drives.set(drive, remote)
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
    const failed = () => { mappedDriveTableCache = null; mappedDriveFailureUntil = Date.now() + 5000; done(null) }
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(MAPPED_DRIVE_QUERY, 'utf16le').toString('base64')],
      { encoding: 'utf8', timeout: 1500, maxBuffer: 256 * 1024, killSignal: 'SIGKILL', windowsHide: true, shell: false }, (error, stdout) => {
        if (error) { failed(); return }
        try {
          const drives = parseMappedDriveTable(String(stdout || ''))
          mappedDriveTableCache = { drives, expiresAt: Date.now() + MAPPED_DRIVE_TABLE_TTL_MS }
          done(new Map(drives))
        } catch { failed() }
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
