import type { IpcHandlerRuntime,IpcHandleRegistrar } from '../ipcHandlerTypes'

export function registerSecurityIpcHandlers(handle: IpcHandleRegistrar, runtime: IpcHandlerRuntime): void {
  handle('license:getStatus', () => {
    if (!runtime.getLicenseStatus) {
      return {
        status: 'missing',
        edition: 'community',
        source: 'bundled-default',
        features: [],
        message: 'license runtime is not initialized'
      }
    }
    return runtime.getLicenseStatus()
  })
}
