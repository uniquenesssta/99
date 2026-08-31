import { createFeatureGateRuntime } from '../license/licenseFeatureGate'
import { createLicenseRuntime } from '../license/licenseRuntime'

export function createMainLicenseBootstrap(options: {
  dataPath: (...segments: string[]) => string
  appendStartupLog: (message: string) => void
}) {
  const licenseRuntime = createLicenseRuntime({
    dataPath: options.dataPath,
    appendLog: options.appendStartupLog,
  })
  const featureGateRuntime = createFeatureGateRuntime(licenseRuntime)
  const status = licenseRuntime.getStatus()

  options.appendStartupLog(`license device id: ${status.deviceId}`)
  options.appendStartupLog(`license status: ${status.status} edition=${status.edition} features=${status.features.join(',')}`)

  return {
    licenseRuntime,
    featureGateRuntime,
  }
}
