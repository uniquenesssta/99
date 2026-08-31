import crypto from 'node:crypto'
import os from 'node:os'
import { basename,isAbsolute,join,relative } from 'node:path'
import { CACHE_ARCHITECTURE_VERSION,ROOT_CACHE_MANIFEST_FILE_NAME,ROOT_INDEX_DB_DIR_NAME } from '../constants'
import { writeJsonAtomic } from '../jsonAtomic'
import type { PreviewStorage,ScanCacheStorageRuntimeOptions } from './scanCacheStorageTypes'

export function createRootPreviewManifestRuntime(options: ScanCacheStorageRuntimeOptions) {
  function rootPreviewCacheManifestPath(previewCacheDir: string): string {
    return join(previewCacheDir, ROOT_CACHE_MANIFEST_FILE_NAME)
  }

  function rootPreviewCacheIdentityPath(previewCacheDir: string): string {
    return join(previewCacheDir, 'identity.json')
  }

  function relativeCachePath(cacheDir: string, filePath: string): string {
    const rel = relative(cacheDir, filePath).replaceAll('\\', '/')
    return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : `${ROOT_INDEX_DB_DIR_NAME}/${basename(filePath)}`
  }

  async function ensureRootPreviewCacheIdentity(previewCacheDir: string, rootPath: string, storage: PreviewStorage): Promise<void> {
    if (await options.exists(rootPreviewCacheIdentityPath(previewCacheDir))) return
    await writeJsonAtomic(rootPreviewCacheIdentityPath(previewCacheDir), {
      cacheId: crypto.randomUUID ? crypto.randomUUID() : options.sha1(`${rootPath}|preview|${Date.now()}|${process.pid}|${Math.random()}`),
      app: options.appName,
      cacheType: 'font-preview-cache',
      storage,
      rootPath,
      architectureVersion: CACHE_ARCHITECTURE_VERSION,
      schemaVersion: options.previewSqliteSchemaVersion,
      ownerMachine: os.hostname(),
      createdAt: new Date().toISOString()
    })
  }

  async function writeRootPreviewCacheManifest(
    previewCacheDir: string,
    rootPath: string,
    storage: PreviewStorage,
    dbPath: string,
    imageDir: string
  ): Promise<void> {
    await ensureRootPreviewCacheIdentity(previewCacheDir, rootPath, storage).catch((error) => {
      options.appendStartupLog(
        `preview cache identity skipped: ${previewCacheDir} ${error instanceof Error ? error.message : String(error)}`
      )
    })
    const manifest = {
      version: 1,
      architectureVersion: CACHE_ARCHITECTURE_VERSION,
      app: options.appName,
      storage,
      rootPath,
      cacheType: 'font-preview-cache',
      cacheSafety: storage === 'root' ? 'shared-nas-preview-cache' : 'local-fallback',
      previewDatabase: relativeCachePath(previewCacheDir, dbPath),
      imageDirectory: relativeCachePath(previewCacheDir, imageDir),
      schemaVersion: options.previewSqliteSchemaVersion,
      writerHost: os.hostname(),
      writerPid: process.pid,
      updatedAt: new Date().toISOString()
    }
    await writeJsonAtomic(rootPreviewCacheManifestPath(previewCacheDir), manifest)
  }

  return { writeRootPreviewCacheManifest }
}
