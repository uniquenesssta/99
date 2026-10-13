import { createHash } from 'node:crypto'
import { win32 } from 'node:path'
import { fileRuntimeFontId } from '../../fonts/fontFileIdentity'
import { normalizePathForCacheCompare } from '../../path/cachePath'
import type { FontItem } from '../../../shared/types'
import type { InstallStatusRuntimeDeps,InstallStatusWorkerItem } from './installStatusTypes'

// Legacy rows remain intact, but name-only results cannot become authoritative.
export const INSTALL_STATUS_EVIDENCE_PREFIX = 'content-v1:'
export const INSTALL_STATUS_PROJECTION_VERSION = 'content-signature-v1'

type SignatureItem = Pick<FontItem, 'id' | 'path' | 'fileName' | 'fileSize' | 'modifiedAt' | 'managedInstallPath' | 'managedRegistryName'>

export function installStatusSignatureValue(item: SignatureItem, deps = {
  sha1: (value: string) => createHash('sha1').update(value).digest('hex'),
  normalizePathForCacheCompare,
}): string {
  if ([item.managedInstallPath, item.managedRegistryName].some(value => value != null && typeof value !== 'string')) throw new Error('invalid-install-status-signature-field')
  return INSTALL_STATUS_EVIDENCE_PREFIX + deps.sha1([
    item.id, deps.normalizePathForCacheCompare(item.path || ''), item.fileName || '',
    Math.round(item.fileSize || 0), Math.round(item.modifiedAt || 0),
    item.managedInstallPath || '', item.managedRegistryName || '',
  ].join('|'))
}

// Build exactly the runtime item used by cachedFontForRuntime/native font_row.
// Historical display names in font_json must not become signature inputs.
export function rootInstallStatusSignature(root: string, entry: string, size: number, mtime: number, json: string): string | null {
  try {
    const source = JSON.parse(json) as Partial<FontItem>
    if (!source || typeof source !== 'object' || Array.isArray(source)) return null
    const path = win32.isAbsolute(entry) ? entry : win32.join(root, entry)
    return installStatusSignatureValue({ ...source, id: fileRuntimeFontId(path, size, mtime), path,
      fileName: win32.basename(path), fileSize: size, modifiedAt: mtime })
  } catch { return null }
}

export function registerInstallStatusSql(db: any): void {
  db.function('hfm_install_status_signature', { deterministic: true },
    (id: string, path: string, fileName: string, fileSize: number, modifiedAt: number, managedInstallPath: string, managedRegistryName: string) =>
      installStatusSignatureValue({ id, path, fileName, fileSize, modifiedAt, managedInstallPath, managedRegistryName }))
  db.function('hfm_root_install_status_signature', { deterministic: true }, rootInstallStatusSignature)
}

export function createInstallStatusSignatureRuntime(deps: InstallStatusRuntimeDeps) {
  function installStatusTaskKey(fontId: string): string {
    return `install_status:${fontId}`
  }

  function installStatusSignature(item: FontItem): string {
    return installStatusSignatureValue(item, deps)
  }

  function installStatusWorkerItem(item: FontItem): InstallStatusWorkerItem {
    return {
      id: item.id,
      sourceId: item.sourceId,
      path: item.path,
      fileName: item.fileName,
      fileSize: item.fileSize,
      modifiedAt: item.modifiedAt,
      managedInstallPath: item.managedInstallPath,
      managedRegistryName: item.managedRegistryName,
      signature: installStatusSignature(item)
    }
  }

  return { installStatusTaskKey, installStatusSignature, installStatusWorkerItem }
}
