import type { HfmFeatureId,HfmLicenseDocument,HfmLicensePublicStatus,HfmLicenseRuntime } from './licenseTypes'
import { createLicenseMachineId } from './licenseMachineId'
import { readFirstLicenseDocument } from './licenseStore'
import { verifyLicenseSignature } from './licenseSignature'

const DEFAULT_COMMUNITY_FEATURES: HfmFeatureId[] = [
  'basic_library',
  'local_tags',
  'font_activation',
  'batch_activation',
  'shared_tags',
  'nas_shared_library',
  'advanced_index',
  'advanced_preview_cache',
  'maintenance_tools'
]

const LOCKED_DOWN_FEATURES: HfmFeatureId[] = ['basic_library', 'local_tags']

export type LicenseRuntimeOptions = {
  dataPath: (...parts: string[]) => string
  appendLog: (message: string) => void
}

function requireSignedLicense(): boolean {
  return process.env.HFM_REQUIRE_SIGNED_LICENSE === '1'
}

function isExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false
  const expires = Date.parse(expiresAt)
  return Number.isFinite(expires) && Date.now() > expires
}

function uniqueFeatures(features: unknown): HfmFeatureId[] {
  return Array.from(new Set(Array.isArray(features) ? features.filter((item): item is HfmFeatureId => typeof item === 'string') : []))
}

function defaultStatus(deviceId: string): HfmLicensePublicStatus {
  const lockedDown = requireSignedLicense()
  return {
    status: lockedDown ? 'missing' : 'valid',
    edition: 'community',
    source: 'bundled-default',
    deviceId,
    features: lockedDown ? LOCKED_DOWN_FEATURES : DEFAULT_COMMUNITY_FEATURES,
    message: lockedDown
      ? '未找到签名 license，已进入基础功能模式。'
      : '未找到签名 license，使用内置社区功能授权。'
  }
}

function validateLicense(document: HfmLicenseDocument, deviceId: string): HfmLicensePublicStatus {
  const features = uniqueFeatures(document.features)
  const base = {
    edition: document.edition || 'community',
    source: 'signed-file' as const,
    deviceId,
    licensedDeviceId: document.deviceId,
    expiresAt: document.expiresAt,
    features
  }

  if (document.version !== 1 || document.product !== 'HanFontManager') {
    return { ...base, status: 'invalid', message: 'license 格式或产品标识无效。' }
  }

  if (!verifyLicenseSignature(document)) {
    return { ...base, status: 'invalid', message: 'license 签名无效。' }
  }

  if (isExpired(document.expiresAt)) {
    return { ...base, status: 'expired', message: 'license 已过期。' }
  }

  if (document.deviceId && document.deviceId !== deviceId) {
    return { ...base, status: 'device_mismatch', message: 'license 与当前设备不匹配。' }
  }

  return { ...base, status: 'valid', message: '签名 license 校验通过。' }
}

export function createLicenseRuntime(options: LicenseRuntimeOptions): HfmLicenseRuntime {
  let cachedStatus: HfmLicensePublicStatus | null = null

  function loadStatus(): HfmLicensePublicStatus {
    const deviceId = createLicenseMachineId()
    try {
      const loaded = readFirstLicenseDocument(options.dataPath)
      if (!loaded) return defaultStatus(deviceId)

      const status = validateLicense(loaded.document, deviceId)
      options.appendLog(`license loaded: source=${loaded.path}, status=${status.status}, edition=${status.edition}, features=${status.features.join(',')}`)
      if (status.status === 'valid') return status

      if (requireSignedLicense()) return status
      const fallback = defaultStatus(deviceId)
      return {
        ...fallback,
        message: `${status.message} 已回退到内置社区功能授权。`
      }
    } catch (error) {
      options.appendLog(`license load failed: ${error instanceof Error ? error.message : String(error)}`)
      return defaultStatus(deviceId)
    }
  }

  function getStatus(): HfmLicensePublicStatus {
    if (!cachedStatus) cachedStatus = loadStatus()
    return cachedStatus
  }

  function featureSet(): Set<HfmFeatureId> {
    const status = getStatus()
    return new Set(status.status === 'valid' ? status.features : LOCKED_DOWN_FEATURES)
  }

  function hasFeature(feature: HfmFeatureId): boolean {
    return featureSet().has(feature)
  }

  function assertFeature(feature: HfmFeatureId, reason?: string): void {
    if (hasFeature(feature)) return
    const status = getStatus()
    throw new Error(`当前授权不允许使用 ${feature}${reason ? `：${reason}` : ''}。授权状态：${status.status}`)
  }

  return {
    getStatus,
    reload: () => {
      cachedStatus = loadStatus()
      return cachedStatus
    },
    hasFeature,
    assertFeature,
    featureSet
  }
}
