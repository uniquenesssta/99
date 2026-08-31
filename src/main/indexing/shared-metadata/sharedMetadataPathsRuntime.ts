import { join, resolve } from 'node:path'
import { ROOT_CACHE_DIR_NAME, ROOT_CACHE_LOCK_DIR_NAME, ROOT_INDEX_DB_DIR_NAME } from '../../cache/constants'

export function sharedMetadataDbPathForRoot(rootPath: string): string {
  return join(resolve(rootPath), ROOT_CACHE_DIR_NAME, ROOT_INDEX_DB_DIR_NAME, 'shared-metadata.sqlite')
}

export function sharedMetadataLockPathForRoot(rootPath: string): string {
  return join(resolve(rootPath), ROOT_CACHE_DIR_NAME, ROOT_CACHE_LOCK_DIR_NAME, 'shared-metadata.lock')
}
