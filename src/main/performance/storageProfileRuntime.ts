import { execFile } from 'node:child_process'
import {
driveLetterFromPath,
getStorageProfile,
parseMappedNetworkDriveLetters,
scanWorkerLimitForStorageProfiles,
type StorageProfile,
type WindowsDriveStorageInfo
} from './storageProfile'

export interface StorageProfileRuntimeOptions {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  localWorkers: number
  networkWorkers: number
  windowsMediaDetectEnabled: boolean
  windowsMediaDetectTimeoutMs: number
  verbose?: boolean
  logger?: (message: string) => void
}

export interface StorageProfileRuntime {
  mappedNetworkDriveLetters(): Set<string>
  windowsDriveStorageInfo(driveLetter: string): WindowsDriveStorageInfo | null
  storageProfileForPath(filePath: string): StorageProfile
  isLikelyNetworkPath(filePath: string): boolean
  scanWorkerCount(jobCount: number, roots?: string[]): number
}

export function createStorageProfileRuntime(options: StorageProfileRuntimeOptions): StorageProfileRuntime {
  let mappedNetworkDriveLettersCache: Set<string> | null = null
  let mappedExpiresAt = 0
  let mappedInFlight = false
  const mediaCache = new Map<string, { value: WindowsDriveStorageInfo | null; expiresAt: number }>()
  const mediaInFlight = new Set<string>()

  function runProbe(command: string, args: string[], timeout: number, done: (output: string | null) => void): void {
    const startedAt = Date.now()
    execFile(command, args, { windowsHide: true, timeout, encoding: 'utf8' }, (error, stdout) => {
      done(error ? null : String(stdout || ''))
      try { if (options.verbose) options.logger?.(`storage probe completed: command=${command}, ok=${!error}, elapsedMs=${Date.now() - startedAt}`) } catch { /* Logging cannot fail a completed probe. */ }
    })
  }

  const mappedNetworkDriveLetters = (): Set<string> => {
    if (options.platform !== 'win32') return new Set<string>()
    if (!mappedInFlight && Date.now() >= mappedExpiresAt) {
      mappedInFlight = true
      runProbe('net', ['use'], 2500, output => {
        const next = output === null ? null : parseMappedNetworkDriveLetters(output)
        if ([...(next || [])].sort().join() !== [...(mappedNetworkDriveLettersCache || [])].sort().join()) mediaCache.clear()
        mappedNetworkDriveLettersCache = next
        mappedExpiresAt = Date.now() + (output === null ? 5000 : 30000)
        mappedInFlight = false
      })
    }
    return new Set(mappedNetworkDriveLettersCache || [])
  }

  const windowsDriveStorageInfo = (driveLetter: string): WindowsDriveStorageInfo | null => {
    const drive = String(driveLetter || '').trim().toUpperCase()
    if (!/^[A-Z]$/.test(drive) || options.platform !== 'win32' || !options.windowsMediaDetectEnabled) return null
    if (mappedNetworkDriveLetters().has(drive) || !mappedNetworkDriveLettersCache || mappedInFlight) return null
    const cached = mediaCache.get(drive)
    if (cached && Date.now() < cached.expiresAt) return cached.value
    if (!mediaInFlight.has(drive)) {
      mediaInFlight.add(drive)
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        `$letter='${drive}'`,
        '$partition = Get-Partition -DriveLetter $letter | Select-Object -First 1',
        'if ($partition) {',
        '  $disk = $partition | Get-Disk',
        '  $physical = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq $disk.Number } | Select-Object -First 1',
        "  $mediaType = ''",
        '  if ($physical) { $mediaType = [string]$physical.MediaType }',
        "  [pscustomobject]@{ BusType = [string]$disk.BusType; MediaType = $mediaType; DriveType = '' } | ConvertTo-Json -Compress",
        '}'
      ].join('\n')
      runProbe('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], options.windowsMediaDetectTimeoutMs, output => {
        let value: WindowsDriveStorageInfo | null = null
        try {
          const parsed = JSON.parse(output || 'null')
          if (parsed && typeof parsed === 'object') value = {
            mediaType: String(parsed.mediaType || parsed.MediaType || ''),
            busType: String(parsed.busType || parsed.BusType || ''),
            driveType: String(parsed.driveType || parsed.DriveType || ''),
          }
        } catch { /* Retry failed/empty probes later; never block foreground I/O. */ }
        mediaCache.set(drive, { value, expiresAt: Date.now() + (value ? 300000 : 5000) })
        mediaInFlight.delete(drive)
      })
    }
    return null
  }

  const storageProfileForPath = (filePath: string): StorageProfile => {
    const drive = driveLetterFromPath(filePath)
    const mappedDrives = mappedNetworkDriveLetters()
    const base = getStorageProfile(filePath, { platform: options.platform, mappedNetworkDriveLetters: mappedDrives, env: options.env })
    if (base.reason === 'env-override' || base.isNetwork || options.platform !== 'win32' || !drive) return base
    // Until classification settles, use the existing conservative network lane.
    if (!mappedNetworkDriveLettersCache || mappedInFlight) return { ...base, type: 'network', isNetwork: true, reason: 'mapping-probe-pending' }
    const info = windowsDriveStorageInfo(drive)
    if (options.windowsMediaDetectEnabled && !info) return { ...base, type: 'network', isNetwork: true, reason: 'media-probe-pending' }
    return getStorageProfile(filePath, { platform: options.platform, mappedNetworkDriveLetters: mappedDrives, env: options.env, driveInfo: info })
  }

  const scanWorkerCount = (jobCount: number, roots: string[] = []): number => {
    if (jobCount <= 0) return 0
    const profiles = roots.map(storageProfileForPath)
    const limit = scanWorkerLimitForStorageProfiles(profiles, {
      localWorkers: options.localWorkers,
      networkWorkers: options.networkWorkers
    })
    return Math.max(1, Math.min(limit, jobCount))
  }

  return {
    mappedNetworkDriveLetters,
    windowsDriveStorageInfo,
    storageProfileForPath,
    isLikelyNetworkPath: (filePath: string): boolean => storageProfileForPath(filePath).isNetwork,
    scanWorkerCount
  }
}
