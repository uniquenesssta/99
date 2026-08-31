import { app } from 'electron'
import fs from 'node:fs'
import { dirname,join,resolve } from 'node:path'

export type AppDataRootPolicyOptions = {
  appName: string
  dataDirName: string
}

export function resolveAppInstallDir(): string {
  if (app.isPackaged) return dirname(app.getPath('exe'))
  return process.cwd()
}

export function resolvePersistentAppBaseRoot(options: AppDataRootPolicyOptions): string {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) return join(localAppData, options.appName)
  }

  return join(app.getPath('appData'), options.appName)
}

export function resolvePersistentUserDataRoot(options: AppDataRootPolicyOptions): string {
  const customDataDir = process.env.HFM_DATA_DIR
  if (customDataDir) return resolve(customDataDir)
  return resolvePersistentAppBaseRoot(options)
}

export function resolveElectronUserDataRoot(options: AppDataRootPolicyOptions): string {
  const customElectronDataDir = process.env.HFM_ELECTRON_USER_DATA_DIR
  if (customElectronDataDir) return resolve(customElectronDataDir)
  return join(resolvePersistentAppBaseRoot(options), 'electron')
}

export function configureElectronUserDataRoot(options: AppDataRootPolicyOptions): string {
  const root = resolveElectronUserDataRoot(options)
  fs.mkdirSync(root, { recursive: true })
  app.setPath('userData', root)
  return root
}

export function legacyInstallDataRoot(options: AppDataRootPolicyOptions): string {
  return join(resolveAppInstallDir(), options.dataDirName)
}

export function legacyRoamingElectronUserDataRoot(options: AppDataRootPolicyOptions): string {
  const roamingAppData = process.env.APPDATA
  if (process.platform === 'win32' && roamingAppData) return join(roamingAppData, options.appName)
  return join(app.getPath('appData'), options.appName)
}

export function legacyRoamingElectronUserDataDataRoot(options: AppDataRootPolicyOptions): string {
  return join(legacyRoamingElectronUserDataRoot(options), options.dataDirName)
}

export function legacyLocalElectronDataRoot(options: AppDataRootPolicyOptions): string {
  return join(resolvePersistentAppBaseRoot(options), 'electron')
}

export function legacyPollutedPersistentDataRoot(options: AppDataRootPolicyOptions): string {
  return join(resolvePersistentAppBaseRoot(options), options.dataDirName)
}
