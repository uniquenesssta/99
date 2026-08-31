export type HfmLicenseEdition = 'community' | 'pro' | 'team' | 'enterprise'

export type HfmFeatureId =
  | 'basic_library'
  | 'local_tags'
  | 'font_activation'
  | 'batch_activation'
  | 'shared_tags'
  | 'nas_shared_library'
  | 'advanced_index'
  | 'advanced_preview_cache'
  | 'maintenance_tools'

export type HfmLicenseDocument = {
  version: 1
  product: 'HanFontManager'
  edition: HfmLicenseEdition
  issuedAt: string
  expiresAt?: string
  deviceId?: string
  seats?: number
  features: HfmFeatureId[]
  note?: string
  signature: string
}

export type HfmLicenseValidationStatus = 'valid' | 'missing' | 'invalid' | 'expired' | 'device_mismatch'

export type HfmLicensePublicStatus = {
  status: HfmLicenseValidationStatus
  edition: HfmLicenseEdition
  source: 'signed-file' | 'bundled-default'
  deviceId: string
  licensedDeviceId?: string
  expiresAt?: string
  features: HfmFeatureId[]
  message: string
}

export type HfmLicenseRuntime = {
  getStatus: () => HfmLicensePublicStatus
  reload: () => HfmLicensePublicStatus
  hasFeature: (feature: HfmFeatureId) => boolean
  assertFeature: (feature: HfmFeatureId, reason?: string) => void
  featureSet: () => Set<HfmFeatureId>
}
