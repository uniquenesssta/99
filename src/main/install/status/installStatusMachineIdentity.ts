import { promises as fsp } from 'node:fs'
import os from 'node:os'
import { join,resolve } from 'node:path'
import type { InstallStatusRuntimeDeps } from './installStatusTypes'

export function createInstallStatusMachineIdentityRuntime(deps: InstallStatusRuntimeDeps) {
  async function localMachineId(): Promise<string> {
    await deps.ensureCacheIdentity()
    try {
      const raw = await fsp.readFile(deps.cacheIdentityPath(), 'utf-8')
      const parsed = JSON.parse(raw) as { cacheId?: string }
      const value = String(parsed.cacheId || '').trim()
      if (value) return value.replace(/[^a-zA-Z0-9._-]+/g, '-')
    } catch {
      // rewritten below
    }
    const fallback = deps.sha1(`${os.hostname()}|${process.env.USERNAME || process.env.USER || ''}`).slice(0, 24)
    return fallback
  }

  async function installStatusDbPathForRoot(rootPath: string): Promise<string> {
    const machine = await localMachineId()
    return join(deps.rootCacheDir(resolve(rootPath)), 'machines', machine, 'install.sqlite')
  }

  async function fallbackInstallStatusDbPath(): Promise<string> {
    const machine = await localMachineId()
    return deps.dataPath('machines', machine, 'install.sqlite')
  }

  async function rootForFontPath(fontPath: string, folders?: string[]): Promise<string | null> {
    const roots = folders || await deps.appWatchedFolders()
    return deps.findBestWatchedRootForFile(fontPath, roots)
  }

  return {
    localMachineId,
    installStatusDbPathForRoot,
    fallbackInstallStatusDbPath,
    rootForFontPath
  }
}
