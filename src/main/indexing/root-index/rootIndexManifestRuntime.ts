import crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import {
  CACHE_ARCHITECTURE_VERSION,
  ROOT_CACHE_LOCK_DIR_NAME,
  ROOT_EVENTS_DB_FILE_NAME,
  ROOT_HASH_DB_FILE_NAME,
  ROOT_INDEX_DB_DIR_NAME,
  ROOT_INDEX_DB_FILE_NAME,
  ROOT_INDEX_DB_SCHEMA_VERSION,
  ROOT_INDEX_LOCK_FILE_NAME,
  ROOT_METRICS_DB_FILE_NAME,
} from '../../cache/constants'
import { relativeCachePath, rootCacheIdentityPath, rootCacheManifestPath, safeManifestDatabasePath, writeJsonAtomic } from './rootIndexFileRuntime'
import { createRootIndexLatestRuntime, rootIndexLatestPointerPath } from './rootIndexLatestRuntime'
import { createSharedRootIdentityRuntime } from './sharedRootIdentityRuntime'
import { sha1 } from './rootIndexSqliteRuntime'
import type { RootCacheManifestFile, RootIndexRuntimeDeps, RootIndexStorage } from './rootIndexTypes'

export function createRootIndexManifestRuntime(deps: RootIndexRuntimeDeps) {
  const {
    resolveLatestRootIndexDbPath,
    writeRootIndexLatestPointer,
    validateRootIndexLatestPointer,
  } = createRootIndexLatestRuntime({
    exists: deps.exists,
    appendStartupLog: deps.appendStartupLog,
  })
  const {
    readSharedRootIdentity,
    ensureSharedRootIdentity,
  } = createSharedRootIdentityRuntime({
    appName: deps.appName,
    exists: deps.exists,
    appendStartupLog: deps.appendStartupLog,
  })
  async function ensureRootCacheIdentity(cacheDir: string, rootPath: string, storage: RootIndexStorage): Promise<void> {
    if (await deps.exists(rootCacheIdentityPath(cacheDir))) return
    await writeJsonAtomic(rootCacheIdentityPath(cacheDir), {
      cacheId: crypto.randomUUID ? crypto.randomUUID() : sha1(`${rootPath}|${Date.now()}|${process.pid}|${Math.random()}`),
      app: deps.appName,
      storage,
      rootPath,
      architectureVersion: CACHE_ARCHITECTURE_VERSION,
      schemaVersion: ROOT_INDEX_DB_SCHEMA_VERSION,
      ownerMachine: os.hostname(),
      createdAt: new Date().toISOString()
    })
  }

  async function readRootCacheManifest(cacheDir: string): Promise<RootCacheManifestFile | null> {
    try {
      const raw = await fsp.readFile(rootCacheManifestPath(cacheDir), 'utf-8')
      return JSON.parse(raw) as RootCacheManifestFile
    } catch {
      return null
    }
  }

  async function resolveActiveRootIndexDbPath(cacheDir: string, defaultDbPath: string): Promise<string> {
    const latestPath = await resolveLatestRootIndexDbPath(cacheDir).catch((error) => {
      deps.appendStartupLog(`root index latest pointer resolve skipped: ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    if (latestPath) return latestPath

    const manifest = await readRootCacheManifest(cacheDir)
    const activePath = safeManifestDatabasePath(cacheDir, manifest?.activeDatabase || manifest?.indexDatabase)
    if (activePath && await deps.exists(activePath)) return activePath
    return defaultDbPath
  }

  async function writeRootCacheManifest(cacheDir: string, rootPath: string, storage: RootIndexStorage, fileCount = 0, activeDbPath?: string): Promise<void> {
    await ensureRootCacheIdentity(cacheDir, rootPath, storage).catch((error) => {
      deps.appendStartupLog(`root cache identity skipped: ${cacheDir} ${error instanceof Error ? error.message : String(error)}`)
    })
    const rootIdentity = await ensureSharedRootIdentity(cacheDir, rootPath, storage).catch((error) => {
      deps.appendStartupLog(`shared root identity skipped: ${cacheDir} ${error instanceof Error ? error.message : String(error)}`)
      return null
    })
    const activeDatabase = relativeCachePath(cacheDir, activeDbPath || join(cacheDir, ROOT_INDEX_DB_DIR_NAME, ROOT_INDEX_DB_FILE_NAME))
    const manifest = {
      version: 4,
      architectureVersion: CACHE_ARCHITECTURE_VERSION,
      app: deps.appName,
      storage,
      rootPath,
      rootId: rootIdentity?.rootId,
      canonicalPath: rootIdentity?.canonicalPath || rootPath,
      aliases: rootIdentity?.aliases || [rootPath],
      cacheType: 'font-index',
      cacheSafety: 'shared-nas-single-writer-lock+atomic-manifest',
      indexDatabase: `${ROOT_INDEX_DB_DIR_NAME}/${ROOT_INDEX_DB_FILE_NAME}`,
      eventsDatabase: `${ROOT_INDEX_DB_DIR_NAME}/${ROOT_EVENTS_DB_FILE_NAME}`,
      hashDatabase: `${ROOT_INDEX_DB_DIR_NAME}/${ROOT_HASH_DB_FILE_NAME}`,
      metricsDatabase: `${ROOT_INDEX_DB_DIR_NAME}/${ROOT_METRICS_DB_FILE_NAME}`,
      machineInstallDatabase: `.hfm-cache/machines/<machine-id>/install.sqlite`,
      activeDatabase,
      lockFile: `${ROOT_CACHE_LOCK_DIR_NAME}/${ROOT_INDEX_LOCK_FILE_NAME}`,
      latestPointer: relativeCachePath(cacheDir, rootIndexLatestPointerPath(cacheDir)),
      legacyJsonSnapshot: null,
      indexCacheVersion: deps.fontScanCacheVersion,
      scriptDetectionVersion: deps.scriptDetectionVersion,
      schemaVersion: ROOT_INDEX_DB_SCHEMA_VERSION,
      fileCount,
      writerHost: os.hostname(),
      writerPid: process.pid,
      updatedAt: new Date().toISOString()
    }
    await writeJsonAtomic(rootCacheManifestPath(cacheDir), manifest)
    await writeRootIndexLatestPointer(cacheDir, rootPath, storage, fileCount, activeDbPath || join(cacheDir, ROOT_INDEX_DB_DIR_NAME, ROOT_INDEX_DB_FILE_NAME))
  }

  return {
    ensureRootCacheIdentity,
    readRootCacheManifest,
    resolveActiveRootIndexDbPath,
    writeRootCacheManifest,
    validateRootIndexLatestPointer,
    readSharedRootIdentity,
    ensureSharedRootIdentity,
  }
}
