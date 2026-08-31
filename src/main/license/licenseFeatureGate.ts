import type { HfmFeatureId,HfmLicenseRuntime } from './licenseTypes'

const CHANNEL_FEATURES: Record<string, HfmFeatureId> = {
  'fonts:activateFont': 'font_activation',
  'fonts:deactivateFont': 'font_activation',
  'fonts:activateFonts': 'batch_activation',
  'fonts:deactivateFonts': 'batch_activation'
}

export type FeatureGateRuntime = {
  featureForChannel: (channel: string) => HfmFeatureId | null
  assertFeatureForChannel: (channel: string) => void
}

export function createFeatureGateRuntime(licenseRuntime: HfmLicenseRuntime): FeatureGateRuntime {
  function featureForChannel(channel: string): HfmFeatureId | null {
    return CHANNEL_FEATURES[channel] || null
  }

  function assertFeatureForChannel(channel: string): void {
    const feature = featureForChannel(channel)
    if (!feature) return
    licenseRuntime.assertFeature(feature, channel)
  }

  return {
    featureForChannel,
    assertFeatureForChannel
  }
}
