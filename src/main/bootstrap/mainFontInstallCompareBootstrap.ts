import { createInstallCompareRuntime } from "../install/fontInstallCompare"

export function createMainFontInstallCompareRuntime(appName: string): ReturnType<typeof createInstallCompareRuntime> {
  return createInstallCompareRuntime({ appName })
}
