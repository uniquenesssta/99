import { assertApplicationOpen } from '../../app/shutdownCoordinatorRuntime'
import { sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { rethrowSharedIoProcessError } from '../../path/sharedIoProcessRuntime'
import os from 'node:os'
import { basename, join } from 'node:path'
import {
  ROOT_INDEX_DB_DIR_NAME,
  ROOT_INDEX_LATEST_FILE_NAME,
  ROOT_INDEX_DB_SCHEMA_VERSION,
} from '../../cache/constants'
import { relativeCachePath, safeManifestDatabasePath, writeJsonAtomic } from './rootIndexFileRuntime'
import type { RootIndexStorage } from './rootIndexTypes'

export interface RootIndexLatestPointerFile {
  version: number
  pointerType: 'root-index-latest'
  activeDatabase: string
  activeDatabaseName: string
  rootPath: string
  storage: RootIndexStorage | string
  schemaVersion: number
  fileCount: number
  writerHost: string
  writerPid: number
  switchMode: 'atomic-latest-pointer'
  updatedAt: string
}

export interface RootIndexLatestRuntimeDeps {
  exists: (filePath: string) => Promise<boolean>
  appendStartupLog: (line: string) => void
}

export function rootIndexLatestPointerPath(cacheDir: string): string {
  return join(cacheDir, ROOT_INDEX_DB_DIR_NAME, ROOT_INDEX_LATEST_FILE_NAME)
}

export function createRootIndexLatestRuntime(deps: RootIndexLatestRuntimeDeps) {

  async function readRootIndexLatestPointer(cacheDir: string): Promise<RootIndexLatestPointerFile | null> {
    try {
      const raw = await fsp.readFile(rootIndexLatestPointerPath(cacheDir), 'utf-8')
      const parsed = JSON.parse(raw) as Partial<RootIndexLatestPointerFile>
      if (parsed.pointerType !== 'root-index-latest' || typeof parsed.activeDatabase !== 'string') return null
      return parsed as RootIndexLatestPointerFile
    } catch (error) {
      rethrowSharedIoProcessError(error)
      return null
    }
  }

  async function resolveLatestRootIndexDbPath(cacheDir: string): Promise<string | null> {
    const latest = await readRootIndexLatestPointer(cacheDir)
    const activePath = safeManifestDatabasePath(cacheDir, latest?.activeDatabase)
    if (activePath && await deps.exists(activePath)) return activePath
    return null
  }

  async function writeRootIndexLatestPointer(cacheDir: string, rootPath: string, storage: RootIndexStorage, fileCount: number, activeDbPath: string): Promise<void> {
    const activeDatabase = relativeCachePath(cacheDir, activeDbPath)
    const pointer: RootIndexLatestPointerFile = {
      version: 1,
      pointerType: 'root-index-latest',
      activeDatabase,
      activeDatabaseName: basename(activeDbPath),
      rootPath,
      storage,
      schemaVersion: ROOT_INDEX_DB_SCHEMA_VERSION,
      fileCount,
      writerHost: os.hostname(),
      writerPid: process.pid,
      switchMode: 'atomic-latest-pointer',
      updatedAt: new Date().toISOString(),
    }
    assertApplicationOpen()
    await writeJsonAtomic(rootIndexLatestPointerPath(cacheDir), pointer)
  }

  async function validateRootIndexLatestPointer(cacheDir: string): Promise<{
    ok: boolean
    pointerExists: boolean
    activeDatabase?: string
    activeDbPath?: string
    reason?: string
  }> {
    const latestPath = rootIndexLatestPointerPath(cacheDir)
    const pointerExists = await deps.exists(latestPath)
    if (!pointerExists) return { ok: false, pointerExists: false, reason: 'latest pointer missing' }
    const pointer = await readRootIndexLatestPointer(cacheDir)
    if (!pointer) return { ok: false, pointerExists: true, reason: 'latest pointer invalid json or type' }
    const activeDbPath = safeManifestDatabasePath(cacheDir, pointer.activeDatabase)
    if (!activeDbPath) return { ok: false, pointerExists: true, activeDatabase: pointer.activeDatabase, reason: 'active database path unsafe' }
    if (!(await deps.exists(activeDbPath))) return { ok: false, pointerExists: true, activeDatabase: pointer.activeDatabase, activeDbPath, reason: 'active database missing' }
    return { ok: true, pointerExists: true, activeDatabase: pointer.activeDatabase, activeDbPath }
  }

  return {
    readRootIndexLatestPointer,
    resolveLatestRootIndexDbPath,
    writeRootIndexLatestPointer,
    validateRootIndexLatestPointer,
  }
}
