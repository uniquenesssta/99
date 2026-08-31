import { execFileSync } from 'node:child_process'
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
  const windowsDriveStorageInfoCache = new Map<string, WindowsDriveStorageInfo | null>()
  const storageProfileCache = new Map<string, StorageProfile>()

  const mappedNetworkDriveLetters = (): Set<string> => {
    if (mappedNetworkDriveLettersCache) return mappedNetworkDriveLettersCache
    const drives = new Set<string>()
    if (options.platform !== 'win32') {
      mappedNetworkDriveLettersCache = drives
      return drives
    }
    try {
      const output = execFileSync('net', ['use'], { windowsHide: true, timeout: 2500, encoding: 'utf8' })
      for (const drive of parseMappedNetworkDriveLetters(String(output || ''))) drives.add(drive)
    } catch {
      // 无映射盘或 net use 不可用时按本地盘处理；可用 HFM_SCAN_NETWORK_WORKERS 手动压低并发。
    }
    mappedNetworkDriveLettersCache = drives
    return drives
  }

  const windowsDriveStorageInfo = (driveLetter: string): WindowsDriveStorageInfo | null => {
    const drive = String(driveLetter || '').trim().slice(0, 1).toUpperCase()
    if (!drive || options.platform !== 'win32' || !options.windowsMediaDetectEnabled) return null
    if (windowsDriveStorageInfoCache.has(drive)) return windowsDriveStorageInfoCache.get(drive) || null

    try {
      const script = [
        "$ErrorActionPreference='SilentlyContinue'",
        `$letter='${drive}'`,
        '$partition = Get-Partition -DriveLetter $letter | Select-Object -First 1',
        'if ($partition) {',
        '  $disk = $partition | Get-Disk',
        '  $physical = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq $disk.Number } | Select-Object -First 1',
        "  $mediaType = ''",
        '  if ($physical) { $mediaType = [string]$physical.MediaType }',
        '  [pscustomobject]@{',
        '    BusType = [string]$disk.BusType',
        '    MediaType = $mediaType',
        "    DriveType = ''",
        '  } | ConvertTo-Json -Compress',
        '}'
      ].join('\n')
      const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        timeout: options.windowsMediaDetectTimeoutMs,
        encoding: 'utf8'
      })
      const trimmed = String(output || '').trim()
      const parsed = trimmed ? JSON.parse(trimmed) as Record<string, unknown> : null
      const info = parsed && typeof parsed === 'object'
        ? {
            mediaType: parsed.mediaType || parsed.MediaType ? String(parsed.mediaType || parsed.MediaType) : undefined,
            busType: parsed.busType || parsed.BusType ? String(parsed.busType || parsed.BusType) : undefined,
            driveType: parsed.driveType || parsed.DriveType ? String(parsed.driveType || parsed.DriveType) : undefined
          }
        : null
      windowsDriveStorageInfoCache.set(drive, info)
      return info
    } catch (error) {
      windowsDriveStorageInfoCache.set(drive, null)
      if (options.verbose) {
        const reason = error instanceof Error && error.name ? error.name : 'PowerShellProbeError'
        options.logger?.(`storage media detect skipped for ${drive}: ${reason}`)
      }
      return null
    }
  }

  const storageProfileForPath = (filePath: string): StorageProfile => {
    const drive = driveLetterFromPath(filePath)
    const mappedDrives = mappedNetworkDriveLetters()
    const cacheKey = `${options.platform}|${drive || ''}|${String(filePath || '').slice(0, 256)}|${mappedDrives.size}`
    const cached = storageProfileCache.get(cacheKey)
    if (cached) return cached

    const profile = getStorageProfile(filePath, {
      platform: options.platform,
      mappedNetworkDriveLetters: mappedDrives,
      env: options.env,
      driveInfo: drive ? windowsDriveStorageInfo(drive) : null
    })
    storageProfileCache.set(cacheKey, profile)
    return profile
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
