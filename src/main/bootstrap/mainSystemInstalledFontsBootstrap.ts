import { createSystemInstalledFontsRuntime } from '../install/systemInstalledFontsRuntime'

type SystemInstalledFontsRuntimeDeps = Parameters<typeof createSystemInstalledFontsRuntime>[0]

export function createMainSystemInstalledFontsBootstrap(deps: SystemInstalledFontsRuntimeDeps) {
  const systemInstalledFontsRuntime = createSystemInstalledFontsRuntime(deps)
  const {
    clearInstalledFontsMemoryCache,
    getSystemInstalledFonts,
    getSystemInstalledFontsCached,
    scanSystemInstalledFonts,
  } = systemInstalledFontsRuntime

  return {
    systemInstalledFontsRuntime,
    clearInstalledFontsMemoryCache,
    getSystemInstalledFonts,
    getSystemInstalledFontsCached,
    scanSystemInstalledFonts,
  }
}
