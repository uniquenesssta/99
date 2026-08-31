import { createInstalledFontsLightweightReader } from './refresh/installedFontsLightweightReader'
import { createInstallStatusCompareRuntime } from './refresh/installStatusCompareRuntime'
import { createInstallStatusRefreshRunner } from './refresh/installStatusRefreshRunner'
import {
DEFAULT_LIGHTWEIGHT_MISSING_THRESHOLD,
DEFAULT_REFRESH_BATCH_SIZE,
type InstallStatusRefreshRuntime,
type InstallStatusRefreshRuntimeDeps
} from './refresh/installStatusRefreshTypes'

export type { InstallStatusRefreshRuntime,InstallStatusRefreshRuntimeDeps } from './refresh/installStatusRefreshTypes'

export function createInstallStatusRefreshRuntime(
  deps: InstallStatusRefreshRuntimeDeps
): InstallStatusRefreshRuntime {
  const installStatusRefreshBatchSize =
    deps.installStatusRefreshBatchSize ?? DEFAULT_REFRESH_BATCH_SIZE
  const lightweightMissingThreshold =
    deps.lightweightMissingThreshold ?? DEFAULT_LIGHTWEIGHT_MISSING_THRESHOLD
  const lightweightReader = createInstalledFontsLightweightReader(deps)
  const compareRuntime = createInstallStatusCompareRuntime(deps)
  const refreshRunner = createInstallStatusRefreshRunner(deps, {
    installStatusRefreshBatchSize,
    lightweightMissingThreshold,
    readSystemInstalledFontsLightweight: lightweightReader.readSystemInstalledFontsLightweight
  })

  return {
    ...compareRuntime,
    ...refreshRunner,
    ...lightweightReader
  }
}
