import { join } from 'node:path'
import type { PreviewCacheStorage, PreviewSharedCacheStorage } from './previewRuntimeTypes'

export type PreviewCacheTierRuntimeOptions = {
  localPreviewImageDir: () => string
  rootPreviewImageDir: (rootPath: string) => string
  rootPreviewDbPath: (rootPath: string) => string
  sha1: (value: string) => string
  normalizePathForCacheCompare: (value: string) => string
}

export function createPreviewCacheTierRuntime(options: PreviewCacheTierRuntimeOptions) {
  function localPreviewDirForRoot(rootPath: string): string {
    const rootKey = options.sha1(options.normalizePathForCacheCompare(rootPath || 'root'))
    return join(options.localPreviewImageDir(), 'roots', rootKey, 'images')
  }

  function sharedStorageForRoot(rootPath: string, identity: string): PreviewSharedCacheStorage {
    return {
      dir: options.rootPreviewImageDir(rootPath),
      identity,
      storage: 'root',
      rootPath,
      indexDbPath: options.rootPreviewDbPath(rootPath),
    }
  }

  function localStorageForRoot(rootPath: string, identity: string): PreviewCacheStorage {
    return {
      dir: localPreviewDirForRoot(rootPath),
      identity,
      storage: 'local',
      shared: sharedStorageForRoot(rootPath, identity),
    }
  }

  function localStorageForPath(identity: string): PreviewCacheStorage {
    return {
      dir: options.localPreviewImageDir(),
      identity,
      storage: 'local',
    }
  }

  function previewCacheStorageToShared(storage: PreviewCacheStorage): PreviewCacheStorage | null {
    if (!storage.shared?.rootPath) return null
    return {
      dir: storage.shared.dir,
      identity: storage.shared.identity,
      storage: 'root',
      rootPath: storage.shared.rootPath,
      indexDbPath: storage.shared.indexDbPath,
    }
  }

  return {
    localPreviewDirForRoot,
    localStorageForRoot,
    localStorageForPath,
    previewCacheStorageToShared,
  }
}
