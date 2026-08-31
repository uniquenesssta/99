import type { App } from 'electron'

export type GpuSwitch = [name: string, value?: string]
export type StartupLoggerFn = (message: string) => void

export function configureGpuAcceleration(app: App, switches: GpuSwitch[]): void {
  for (const [name, value] of switches) {
    app.commandLine.appendSwitch(name, value)
  }
}

export function appendGpuStartupSwitchDiagnostics(app: App, switches: GpuSwitch[], disableSwitches: string[], logger: StartupLoggerFn, argv = process.argv): void {
  logger(`gpu acceleration switches: ${switches.map(([name, value]) => value ? `${name}=${value}` : name).join(', ')}`)

  const disabledSwitches = disableSwitches.filter((name) => app.commandLine.hasSwitch(name) || argv.some((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`)))
  if (disabledSwitches.length) {
    logger(`gpu disabling switches detected: ${disabledSwitches.join(', ')}`)
  }
}

export async function appendGpuDiagnostics(app: App, logger: StartupLoggerFn, reason = 'manual'): Promise<void> {
  const gpuAwareApp = app as App & { isHardwareAccelerationEnabled?: () => boolean }

  logger(`gpu diagnostics reason: ${reason}`)

  try {
    if (typeof gpuAwareApp.isHardwareAccelerationEnabled === 'function') {
      logger(`gpu hardware acceleration enabled: ${gpuAwareApp.isHardwareAccelerationEnabled()}`)
    } else {
      logger('gpu hardware acceleration API unavailable before gpu-info-update; using feature status below')
    }
  } catch (error) {
    logger(`gpu hardware acceleration check failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    logger(`gpu feature status: ${JSON.stringify(app.getGPUFeatureStatus())}`)
  } catch (error) {
    logger(`gpu feature status failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    const info = await app.getGPUInfo('basic')
    logger(`gpu info basic: ${JSON.stringify(info)}`)
  } catch (error) {
    logger(`gpu info basic failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
