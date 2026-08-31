import { promises as fsp } from 'node:fs'
import { basename,dirname,resolve } from 'node:path'
import type { InstallStatusRuntimeDeps,SqliteDb } from './installStatusTypes'

export function createInstallStatusDbOpenRuntime(
  deps: InstallStatusRuntimeDeps,
  helpers: {
    installStatusDbPathForRoot: (rootPath: string) => Promise<string>
    fallbackInstallStatusDbPath: () => Promise<string>
    initializeMachineInstallDb: (db: SqliteDb, rootPath: string) => void
  }
) {
  async function openMachineInstallDbForRoot(rootPath: string): Promise<SqliteDb> {
    const dbPath = await helpers.installStatusDbPathForRoot(rootPath)
    await fsp.mkdir(dirname(dbPath), { recursive: true })
    const db = deps.openStableSqliteDb(dbPath, `machine-install:${basename(rootPath)}`)
    helpers.initializeMachineInstallDb(db, resolve(rootPath))
    return db
  }

  async function openFallbackInstallDb(): Promise<SqliteDb> {
    const dbPath = await helpers.fallbackInstallStatusDbPath()
    await fsp.mkdir(dirname(dbPath), { recursive: true })
    const db = deps.openStableSqliteDb(dbPath, 'machine-install:fallback')
    helpers.initializeMachineInstallDb(db, 'local-fallback')
    return db
  }

  return { openMachineInstallDbForRoot, openFallbackInstallDb }
}
