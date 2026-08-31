export type StorageProfileType = 'network' | 'hdd' | 'ssd' | 'nvme' | 'removable' | 'unknown'

export interface WindowsDriveStorageInfo {
  mediaType?: string
  busType?: string
  driveType?: string
}

export interface StorageProfile {
  rootPath: string
  type: StorageProfileType
  reason: string
  isNetwork: boolean
  driveLetter?: string
  mediaType?: string
  busType?: string
}

export interface StorageProfileOptions {
  platform: NodeJS.Platform | string
  mappedNetworkDriveLetters?: Set<string>
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  driveInfo?: WindowsDriveStorageInfo | null
}

const VALID_PROFILE_TYPES = new Set<StorageProfileType>(['network', 'hdd', 'ssd', 'nvme', 'removable', 'unknown'])

export function normalizeWindowsPath(value: string): string {
  return String(value || '').replaceAll('/', '\\')
}

export function driveLetterFromPath(filePath: string): string | null {
  const match = /^([a-zA-Z]):\\/.exec(normalizeWindowsPath(filePath))
  return match?.[1]?.toUpperCase() || null
}

export function storageRootFromPath(filePath: string): string {
  const normalized = normalizeWindowsPath(filePath).trim()
  const deviceUnc = /^\\\\\?\\UNC\\([^\\]+)\\([^\\]+)/i.exec(normalized)
  if (deviceUnc) return `\\\\${deviceUnc[1]}\\${deviceUnc[2]}`

  const unc = /^\\\\([^\\]+)\\([^\\]+)/.exec(normalized)
  if (unc) return `\\\\${unc[1]}\\${unc[2]}`

  const drive = driveLetterFromPath(normalized)
  if (drive) return `${drive}:`
  return normalized || '<unknown>'
}

export function isUncPath(filePath: string): boolean {
  const normalized = normalizeWindowsPath(filePath).trim()
  return /^\\\\(?!\?\\)/.test(normalized) || /^\\\\\?\\UNC\\/i.test(normalized)
}

export function parseMappedNetworkDriveLetters(output: string): Set<string> {
  const drives = new Set<string>()
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = /(?:^|\s)([A-Z]):\s+\\\\/i.exec(line)
    if (match?.[1]) drives.add(match[1].toUpperCase())
  }
  return drives
}

export function normalizeStorageProfileType(value: unknown): StorageProfileType | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) return null
  if (normalized === 'nas' || normalized === 'unc' || normalized === 'lan') return 'network'
  if (normalized === 'usb' || normalized === 'external') return 'removable'
  if (VALID_PROFILE_TYPES.has(normalized as StorageProfileType)) return normalized as StorageProfileType
  return null
}

function profileFromOverride(filePath: string, env: StorageProfileOptions['env']): StorageProfileType | null {
  const drive = driveLetterFromPath(filePath)
  const keys = drive
    ? [`HFM_STORAGE_PROFILE_${drive}`, `HFM_STORAGE_${drive}_PROFILE`, 'HFM_STORAGE_PROFILE_DEFAULT']
    : ['HFM_STORAGE_PROFILE_DEFAULT']
  for (const key of keys) {
    const value = normalizeStorageProfileType(env?.[key])
    if (value) return value
  }
  return null
}

export function classifyWindowsDriveStorageInfo(info?: WindowsDriveStorageInfo | null): { type: StorageProfileType; reason: string } {
  const mediaType = String(info?.mediaType || '').trim().toLowerCase()
  const busType = String(info?.busType || '').trim().toLowerCase()
  const driveType = String(info?.driveType || '').trim().toLowerCase()

  if (driveType === 'network') return { type: 'network', reason: 'windows-drive-type-network' }
  if (driveType === 'removable') return { type: 'removable', reason: 'windows-drive-type-removable' }
  if (mediaType.includes('ssd')) return { type: 'ssd', reason: 'windows-physicaldisk-mediatype-ssd' }
  if (mediaType.includes('hdd')) return { type: 'hdd', reason: 'windows-physicaldisk-mediatype-hdd' }
  if (busType.includes('nvme')) return { type: 'nvme', reason: 'windows-disk-bustype-nvme' }
  if (busType.includes('usb') || busType.includes('sd')) return { type: 'removable', reason: 'windows-disk-bustype-removable' }

  return { type: 'unknown', reason: 'windows-storage-info-unknown' }
}

export function getStorageProfile(filePath: string, options: StorageProfileOptions): StorageProfile {
  const rootPath = storageRootFromPath(filePath)
  const override = profileFromOverride(filePath, options.env)
  if (override) {
    return {
      rootPath,
      type: override,
      reason: 'env-override',
      isNetwork: override === 'network',
      driveLetter: driveLetterFromPath(filePath) || undefined,
      mediaType: options.driveInfo?.mediaType,
      busType: options.driveInfo?.busType
    }
  }

  if (isUncPath(filePath)) {
    return { rootPath, type: 'network', reason: 'unc-path', isNetwork: true }
  }

  const driveLetter = driveLetterFromPath(filePath)
  if (options.platform === 'win32' && driveLetter && options.mappedNetworkDriveLetters?.has(driveLetter)) {
    return { rootPath, type: 'network', reason: 'mapped-network-drive', isNetwork: true, driveLetter }
  }

  if (options.platform === 'win32' && driveLetter) {
    const classified = classifyWindowsDriveStorageInfo(options.driveInfo)
    return {
      rootPath,
      type: classified.type,
      reason: classified.reason,
      isNetwork: classified.type === 'network',
      driveLetter,
      mediaType: options.driveInfo?.mediaType,
      busType: options.driveInfo?.busType
    }
  }

  return { rootPath, type: 'unknown', reason: 'non-windows-or-unclassified', isNetwork: false }
}

export function scanWorkerLimitForStorageProfiles(
  profiles: StorageProfile[],
  options: { localWorkers: number; networkWorkers: number }
): number {
  const types = new Set(profiles.map((profile) => profile.type))
  const hasNetwork = types.has('network')
  const hasLocal = profiles.some((profile) => profile.type !== 'network')
  if (hasNetwork) {
    return hasLocal
      ? Math.min(options.localWorkers, Math.max(options.networkWorkers, Math.floor((options.localWorkers + options.networkWorkers) / 2)))
      : options.networkWorkers
  }
  if (types.has('hdd') || types.has('removable')) {
    return Math.max(1, Math.min(options.localWorkers, Math.max(2, Math.ceil(options.localWorkers / 2))))
  }
  return options.localWorkers
}

export function storageProfileSummary(profiles: StorageProfile[]): string {
  if (!profiles.length) return 'none'
  const parts = profiles.map((profile) => {
    const root = profile.rootPath.replace(/,/g, '，')
    const details = [profile.reason]
    if (profile.mediaType) details.push(`media=${profile.mediaType}`)
    if (profile.busType) details.push(`bus=${profile.busType}`)
    return `${root}:${profile.type}(${details.join(';')})`
  })
  return parts.join(',')
}
