import type { FontItem } from '../../../shared/types'
import type { InstallStatusRuntimeDeps,InstallStatusWorkerItem } from './installStatusTypes'

export function createInstallStatusSignatureRuntime(deps: InstallStatusRuntimeDeps) {
  function installStatusTaskKey(fontId: string): string {
    return `install_status:${fontId}`
  }

  function installStatusSignature(item: FontItem): string {
    return deps.sha1([
      item.id,
      deps.normalizePathForCacheCompare(item.path || ''),
      item.fileName || '',
      Math.round(item.fileSize || 0),
      Math.round(item.modifiedAt || 0),
      item.managedInstallPath || '',
      item.managedRegistryName || ''
    ].join('|'))
  }

  function installStatusWorkerItem(item: FontItem): InstallStatusWorkerItem {
    return {
      id: item.id,
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
