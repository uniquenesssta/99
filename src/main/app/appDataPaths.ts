import { app } from 'electron'
import fs,{ promises as fsp } from 'node:fs'
import { dirname,join,resolve } from 'node:path'
import { normalizePathForCacheCompare } from '../path/cachePath'
import {
legacyInstallDataRoot,
legacyPollutedPersistentDataRoot,
legacyRoamingElectronUserDataDataRoot,
legacyRoamingElectronUserDataRoot,
resolveAppInstallDir,
resolveElectronUserDataRoot,
resolvePersistentUserDataRoot
} from './appDataRootPolicyRuntime'
import {
cleanAppDataRequiredDirectories,
chromiumUserDataEntryNames,
isChromiumUserDataEntry,
resolveCleanAppDataPath
} from './appDataRootLayoutRuntime'

export interface AppDataPathsOptions {
  appName: string
  dataDirName: string
  dataLayoutVersion: number
  cacheArchitectureVersion: number
  appendLog: (line: string) => void
}

export function createAppDataPaths(options: AppDataPathsOptions) {
  let cachedDataRoot: string | null = null

  function appInstallDir(): string {
    return resolveAppInstallDir()
  }

  function dataRoot(): string {
    if (cachedDataRoot) return cachedDataRoot
    cachedDataRoot = resolvePersistentUserDataRoot(options)
    return cachedDataRoot
  }

  function dataPath(...segments: string[]): string {
    return resolveCleanAppDataPath(dataRoot(), ...segments)
  }

  function legacyUserDataRoot(): string {
    return legacyRoamingElectronUserDataRoot(options)
  }

  function isSamePath(a: string, b: string): boolean {
    return normalizePathForCacheCompare(resolve(a)) === normalizePathForCacheCompare(resolve(b))
  }

  function writeDataRootManifestSync(): void {
    const manifest = {
      version: options.dataLayoutVersion,
      architectureVersion: options.cacheArchitectureVersion,
      app: options.appName,
      storage: 'persistent-business-data',
      dataRoot: dataRoot(),
      electronUserDataRoot: resolveElectronUserDataRoot(options),
      installDir: appInstallDir(),
      updatedAt: new Date().toISOString()
    }
    fs.writeFileSync(dataPath('manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8')
  }

  function ensureDataRootSync(): void {
    const root = dataRoot()
    for (const dir of cleanAppDataRequiredDirectories(root)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const probePath = dataPath('.write-test')
    fs.writeFileSync(probePath, String(Date.now()), 'utf-8')
    fs.rmSync(probePath, { force: true })
    writeDataRootManifestSync()
  }

  async function exists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async function copyLegacyFileIfMissing(relativeFilePath: string): Promise<void> {
    const source = join(legacyUserDataRoot(), relativeFilePath)
    const target = dataPath(relativeFilePath)
    if (isSamePath(source, target)) return
    if (await exists(target) || !(await exists(source))) return
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.copyFile(source, target)
  }

  async function copyLegacyDirectoryIfMissing(relativeDirPath: string): Promise<void> {
    const source = join(legacyUserDataRoot(), relativeDirPath)
    const target = dataPath(relativeDirPath)
    if (isSamePath(source, target)) return
    if (await exists(target) || !(await exists(source))) return
    await fsp.cp(source, target, { recursive: true })
  }


  async function removePathIfExists(target: string): Promise<void> {
    await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined)
  }

  async function movePathIfTargetMissing(source: string, target: string): Promise<boolean> {
    if (!(await exists(source))) return false
    await fsp.mkdir(dirname(target), { recursive: true })
    if (await exists(target)) {
      await removePathIfExists(source)
      return false
    }
    try {
      await fsp.rename(source, target)
      return true
    } catch {
      await fsp.cp(source, target, { recursive: true })
      await removePathIfExists(source)
      return true
    }
  }

  async function relocateChromiumUserDataEntriesFromBusinessDataRoot(): Promise<number> {
    const root = dataRoot()
    const electronRoot = resolveElectronUserDataRoot(options)
    const pollutedRoots = [root, legacyPollutedPersistentDataRoot(options)]
    const seenRoots = new Set<string>()
    let moved = 0

    for (const pollutedRoot of pollutedRoots) {
      const normalized = normalizePathForCacheCompare(resolve(pollutedRoot))
      if (!normalized || seenRoots.has(normalized) || isSamePath(pollutedRoot, electronRoot) || !(await exists(pollutedRoot))) continue
      seenRoots.add(normalized)
      for (const entryName of chromiumUserDataEntryNames) {
        const source = join(pollutedRoot, entryName)
        const target = join(electronRoot, entryName)
        if (await movePathIfTargetMissing(source, target)) moved += 1
      }
    }
    return moved
  }

  function legacyDataRoots(): string[] {
    const candidates = [
      legacyInstallDataRoot(options),
      legacyRoamingElectronUserDataRoot(options),
      legacyRoamingElectronUserDataDataRoot(options),
      legacyPollutedPersistentDataRoot(options)
    ]
    const seen = new Set<string>()
    const result: string[] = []
    for (const candidate of candidates) {
      const normalized = normalizePathForCacheCompare(resolve(candidate))
      if (!normalized || seen.has(normalized) || isSamePath(candidate, dataRoot())) continue
      seen.add(normalized)
      result.push(candidate)
    }
    return result
  }

  async function copyLegacyEntryIfMissing(source: string, target: string): Promise<number> {
    if (isSamePath(source, target)) return 0
    const stat = await fsp.stat(source).catch(() => null)
    if (!stat) return 0

    if (stat.isDirectory()) {
      await fsp.mkdir(target, { recursive: true })
      let copied = 0
      const entries = await fsp.readdir(source, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.name === '.write-test') continue
        copied += await copyLegacyEntryIfMissing(join(source, entry.name), join(target, entry.name))
      }
      return copied
    }

    if (await exists(target)) return 0
    await fsp.mkdir(dirname(target), { recursive: true })
    await fsp.copyFile(source, target)
    return 1
  }

  async function migrateLegacyRootIfNeeded(sourceRoot: string): Promise<number> {
    if (!(await exists(sourceRoot))) return 0
    if (isSamePath(sourceRoot, dataRoot())) return 0
    let copied = 0
    const entries = await fsp.readdir(sourceRoot, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.write-test') continue
      if (entry.name === 'manifest.json') continue
      if (isChromiumUserDataEntry(entry.name)) continue
      copied += await copyLegacyEntryIfMissing(join(sourceRoot, entry.name), dataPath(entry.name))
    }
    return copied
  }

  async function migrateLegacyUserDataIfNeeded(): Promise<void> {
    let copied = 0
    const movedChromiumEntries = await relocateChromiumUserDataEntriesFromBusinessDataRoot()
    if (movedChromiumEntries > 0) {
      options.appendLog(`data root cleanup: moved ${movedChromiumEntries} Chromium userData entries from business data root to ${resolveElectronUserDataRoot(options)}`)
    }
    for (const sourceRoot of legacyDataRoots()) {
      const count = await migrateLegacyRootIfNeeded(sourceRoot)
      if (count > 0) {
        options.appendLog(`data root migration: copied ${count} missing entries from ${sourceRoot}`)
      }
      copied += count
    }
    options.appendLog(`data root ready policy: businessDataRoot=${dataRoot()}, electronUserDataRoot=${resolveElectronUserDataRoot(options)}, installDir=${appInstallDir()}, migratedEntries=${copied}, movedChromiumEntries=${movedChromiumEntries}`)
  }

  function dataRootErrorMessage(error: unknown): string {
    const detail = error instanceof Error ? error.message : String(error)
    return `无法写入软件数据目录：${dataRoot()}\n\n请检查当前 Windows 用户是否有 AppData 写入权限，或通过 HFM_DATA_DIR 指定其它可写目录。\n\n错误：${detail}`
  }

  return {
    appInstallDir,
    dataRoot,
    dataPath,
    legacyUserDataRoot,
    isSamePath,
    writeDataRootManifestSync,
    ensureDataRootSync,
    exists,
    copyLegacyFileIfMissing,
    copyLegacyDirectoryIfMissing,
    migrateLegacyUserDataIfNeeded,
    dataRootErrorMessage
  }
}
