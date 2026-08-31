import crypto from 'node:crypto'
import os from 'node:os'
import type { CacheArchitectureInfo,CacheArchitectureRuntimeOptions } from './cacheArchitectureTypes'

export function createCacheArchitectureInfo(options: CacheArchitectureRuntimeOptions): CacheArchitectureInfo {
  return {
    version: options.cacheArchitectureVersion,
    identityPath: options.cacheIdentityPath(),
    dataRoot: options.dataRoot(),
    databases: {
      appSettings: options.appSqlitePath(),
      sharedFontIndex: `${options.rootCacheDirName}/${options.rootIndexDbDirName}/${options.rootIndexDbFileName}`,
      sharedPreviewIndex: `${options.rootPreviewCacheDirName}/${options.previewCacheDbDirName}/${options.previewCacheDbFileName}`,
      sharedPreviewImages: `${options.rootPreviewCacheDirName}/${options.previewCacheImagesDirName}`,
      perMachineInstallStatus: `${options.rootCacheDirName}/machines/<machine-id>/install.sqlite`,
      localPreviewFallback: options.previewSqlitePath()
    },
    startupPolicy: {
      autoScan: false,
      autoSystemFontImport: false,
      recoverScanTasks: false,
      watcherGraceMs: options.watcherStartupGraceMs,
      backgroundTasks: false
    }
  }
}

export function createCacheIdentityPayload(options: CacheArchitectureRuntimeOptions): Record<string, unknown> {
  return {
    cacheId: crypto.randomUUID ? crypto.randomUUID() : options.sha1(`${Date.now()}|${process.pid}|${os.hostname()}|${Math.random()}`),
    app: options.appName,
    architectureVersion: options.cacheArchitectureVersion,
    ownerMachine: os.hostname(),
    createdAt: new Date().toISOString()
  }
}
