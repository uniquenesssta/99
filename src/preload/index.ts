import { contextBridge,ipcRenderer } from 'electron'
import { Buffer } from 'node:buffer'



export type HfmLicensePublicStatus = {
  status: 'valid' | 'missing' | 'invalid' | 'expired' | 'device_mismatch'
  edition: 'community' | 'pro' | 'team' | 'enterprise'
  source: 'signed-file' | 'bundled-default'
  deviceId: string
  licensedDeviceId?: string
  expiresAt?: string
  features: string[]
  message: string
}

export type RendererPerformanceEventPayload = {
  source?: string
  kind?: string
  label?: string
  severity?: string
  durationMs?: number
  timestamp?: number
  page?: string
  details?: Record<string, unknown>
}

const PRELOAD_TRACE_ALWAYS = new Set([
  'library:load',
  'library:loadShell',
  'fonts:scanFolders',
  'fonts:loadFolderCache',
  'fonts:query',
  'fonts:queryPage',
  'fonts:getMetrics',
  'fonts:refreshInstallStatusIndex',
  'fonts:startInstallStatusRefreshIndex',
  'fonts:getInstallStatusIndex',
  'folders:refreshWatched',
  'folders:listPhysicalTree',
  'fonts:renderPreviewImage',
  'fonts:ensurePreviewCache',
  'fonts:getPreviewCacheStatus',
  'fonts:activateFonts',
  'fonts:deactivateFonts',
  'fonts:deleteFiles',
  'fonts:setLocalTagsBatch',
  'fonts:setSharedTagsBatch',
  'fonts:renameSharedTag',
  'fonts:setFavorite',
  'fonts:setDeleteProtection',
  'license:getStatus'
])

function summarizePreloadValue(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return { type: 'array', length: value.length }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return {
      type: 'object',
      keys: Object.keys(record).slice(0, 10),
      total: record.total,
      offset: record.offset,
      limit: record.limit,
      page: record.page,
      sidebarPage: record.sidebarPage,
      search: typeof record.search === 'string' ? record.search.slice(0, 80) : undefined,
      keyword: typeof record.keyword === 'string' ? record.keyword.slice(0, 80) : undefined,
      activeFilterKind: record.activeFilter && typeof record.activeFilter === 'object' ? (record.activeFilter as Record<string, unknown>).kind : undefined,
      activeFilterName: record.activeFilter && typeof record.activeFilter === 'object' ? (record.activeFilter as Record<string, unknown>).name : undefined,
      installStatus: record.installStatus,
      items: Array.isArray(record.items) ? record.items.length : undefined,
      fonts: Array.isArray(record.fonts) ? record.fonts.length : undefined
    }
  }
  return typeof value
}


function fontPathToProtocolUrl(filePath: string): string {
  const encodedPath = Buffer.from(String(filePath || ''), 'utf8').toString('base64url')
  return `hfm-font://local/b64/${encodedPath}`
}

function reportPreloadTrace(payload: RendererPerformanceEventPayload): void {
  ipcRenderer.invoke('performance:rendererTrace', payload).catch(() => undefined)
}

function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  const startedAt = Date.now()
  return ipcRenderer.invoke(channel, ...args)
    .then((result: T) => {
      const durationMs = Date.now() - startedAt
      if (!channel.startsWith('performance:') && (PRELOAD_TRACE_ALWAYS.has(channel) || durationMs >= 80)) {
        reportPreloadTrace({
          source: 'preload',
          kind: 'ipc-renderer',
          label: channel,
          severity: durationMs >= 250 ? 'warn' : durationMs >= 80 ? 'slow' : 'info',
          durationMs,
          timestamp: Date.now(),
          details: {
            args: args.map(summarizePreloadValue),
            result: summarizePreloadValue(result)
          }
        })
      }
      return result
    })
    .catch((error: unknown) => {
      const durationMs = Date.now() - startedAt
      if (!channel.startsWith('performance:')) {
        reportPreloadTrace({
          source: 'preload',
          kind: 'ipc-renderer-error',
          label: channel,
          severity: 'error',
          durationMs,
          timestamp: Date.now(),
          details: { error: error instanceof Error ? error.message : String(error) }
        })
      }
      throw error
    })
}

import type { CacheStats,FontActivationBatchResult,FontDeleteResult,FontIndexChangePayload,FontIndexProgressPayload,FontTagMutationStateSignalPayload,FontItem,FontMetricsResult,FontProtectionResult,FontQueryPageResult,FontQueryRequest,FontQueryResult,FontSearchResult,FontTagBatchItem,FontTagUpdateResult,InstallCompareOptions,InstallCompareResult,InstallResult,InstallStatusProgressPayload,InstallStatusRefreshResult,InstallStatusRefreshStartResult,LibraryShell,LibraryState,MoveFontFileResult,MoveFontFilesResult,PhysicalFolderTreeResult,RenameFolderResult,ScanResult,SystemInstalledFont,WatchedFolderRefreshResult } from '../shared/types'

const api = {
  getLicenseStatus: (): Promise<HfmLicensePublicStatus> => invoke('license:getStatus'),
  loadLibrary: (): Promise<LibraryState> => invoke('library:load'),
  loadLibraryShell: (): Promise<LibraryShell> => invoke('library:loadShell'),
  saveLibrary: (state: LibraryState): Promise<boolean> => invoke('library:save', state),
  selectFontFolders: (): Promise<string[]> => invoke('dialog:selectFontFolders'),
  scanFolders: (folders: string[], knownFonts?: FontItem[]): Promise<ScanResult> => invoke('fonts:scanFolders', folders, knownFonts),
  cancelFontScan: (reason?: string): Promise<{ cancelled: boolean; jobId?: string; message: string }> => invoke('fonts:cancelScan', reason),
  getFontScanStatus: (): Promise<unknown> => invoke('fonts:getScanStatus'),
  loadFolderCache: (folders: string[]): Promise<ScanResult> => invoke('fonts:loadFolderCache', folders),
  searchFonts: (keyword: string, limit?: number): Promise<FontSearchResult> => invoke('fonts:search', keyword, limit),
  queryFonts: (request: FontQueryRequest): Promise<FontQueryResult> => invoke('fonts:query', request),
  queryFontPage: (request: FontQueryRequest): Promise<FontQueryPageResult> => invoke('fonts:queryPage', request),
  checkSharedMetadataUpdates: (reason?: string): Promise<{ changed: boolean; rebuilt: boolean; roots: number; elapsedMs: number; reason: string }> => invoke('fonts:checkSharedMetadataUpdates', reason),
  getFontMetrics: (): Promise<FontMetricsResult> => invoke('fonts:getMetrics'),
  watchFolders: (folders: string[]): Promise<boolean> => invoke('folders:watch', folders),
  refreshWatchedFolder: (folderPath: string, rootPath?: string): Promise<WatchedFolderRefreshResult> => invoke('folders:refreshWatched', folderPath, rootPath),
  createPhysicalFolder: (parentPath: string, name: string): Promise<string> => invoke('folders:createPhysical', parentPath, name),
  renamePhysicalFolder: (folderPath: string, name: string): Promise<RenameFolderResult> => invoke('folders:renamePhysical', folderPath, name),
  listPhysicalFolderTree: (folders: string[]): Promise<PhysicalFolderTreeResult> => invoke('folders:listPhysicalTree', folders),
  moveFontFileToFolder: (item: FontItem, targetFolder: string): Promise<MoveFontFileResult> => invoke('fonts:moveFileToFolder', item, targetFolder),
  moveFontFilesToFolder: (items: FontItem[], targetFolder: string): Promise<MoveFontFilesResult> => invoke('fonts:moveFilesToFolder', items, targetFolder),
  onFoldersChanged: (callback: (payload: { folder: string; eventType: string; fileName: string; at: string }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { folder: string; eventType: string; fileName: string; at: string }): void => callback(payload)
    ipcRenderer.on('folders:changed', listener)
    return () => ipcRenderer.removeListener('folders:changed', listener)
  },
  onFontIndexChanged: (callback: (payload: FontIndexChangePayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: FontIndexChangePayload): void => callback(payload)
    ipcRenderer.on('font-index:changed', listener)
    return () => ipcRenderer.removeListener('font-index:changed', listener)
  },
  onFontIndexProgress: (callback: (payload: FontIndexProgressPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: FontIndexProgressPayload): void => callback(payload)
    ipcRenderer.on('font-index:progress', listener)
    return () => ipcRenderer.removeListener('font-index:progress', listener)
  },
  onFontTagStateSignal: (callback: (payload: FontTagMutationStateSignalPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: FontTagMutationStateSignalPayload): void => callback(payload)
    ipcRenderer.on('font-tags:stateSignal', listener)
    return () => ipcRenderer.removeListener('font-tags:stateSignal', listener)
  },
  onInstallStatusProgress: (callback: (payload: InstallStatusProgressPayload) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: InstallStatusProgressPayload): void => callback(payload)
    ipcRenderer.on('install-status:progress', listener)
    return () => ipcRenderer.removeListener('install-status:progress', listener)
  },
  getCacheStats: (): Promise<CacheStats> => invoke('cache:getStats'),
  getCacheArchitecture: (): Promise<unknown> => invoke('cache:getArchitecture'),
  getMigrationDiagnostics: (): Promise<unknown> => invoke('diagnostics:getMigrationStatus'),
  clearMigrationDiagnostics: (): Promise<unknown> => invoke('diagnostics:clearMigrationStatus'),
  getSharedMetadataDiagnostics: (options?: { roots?: string[]; synchronize?: boolean; includeRepairDryRun?: boolean }): Promise<unknown> => invoke('sharedMetadata:getDiagnostics', options),
  repairSharedMetadata: (options?: { roots?: string[]; apply?: boolean; synchronizeAfterRepair?: boolean; repairInvalidTagJson?: boolean; purgeInvalidTagOps?: boolean; archiveOrphanTagOps?: boolean; purgeArchivedOrphanTagOps?: boolean; orphanArchiveReason?: string }): Promise<unknown> => invoke('sharedMetadata:repair', options),
  getSharedIndexSnapshotDiagnostics: (): Promise<unknown> => invoke('sharedIndexSnapshots:getDiagnostics'),
  repairSharedIndexSnapshots: (options?: { apply?: boolean }): Promise<unknown> => invoke('sharedIndexSnapshots:repair', options),
  clearScanCache: (): Promise<CacheStats> => invoke('cache:clearScanCache'),
  clearPreviewCache: (): Promise<CacheStats> => invoke('cache:clearPreviewCache'),
  runDatabaseHealthCheck: (): Promise<unknown> => invoke('maintenance:healthCheck'),
  createDatabaseBackup: (reason?: string): Promise<unknown> => invoke('maintenance:createBackup', reason),
  runDatabaseMaintenance: (): Promise<unknown> => invoke('maintenance:run'),
  restoreLatestDatabaseBackup: (label: 'library' | 'tasks' | 'preview'): Promise<unknown> => invoke('maintenance:restoreLatestBackup', label),
  listBackgroundTasks: (status?: 'pending' | 'running' | 'done' | 'failed' | 'skipped', limit?: number): Promise<unknown> => invoke('tasks:list', status, limit),
  runBackgroundTasksNow: (): Promise<unknown> => invoke('tasks:runNow'),
  getBackgroundTaskSchedulerStatus: (): Promise<unknown> => invoke('tasks:getSchedulerStatus'),
  reportUserActivity: (durationMs?: number, reason?: string): Promise<unknown> => invoke('performance:userActivity', durationMs, reason),
  reportRendererLongTask: (payload: { durationMs?: number; name?: string; startTime?: number; source?: string }): Promise<unknown> => invoke('performance:rendererLongTask', payload),
  reportPerformanceEvent: (payload: RendererPerformanceEventPayload): Promise<unknown> => invoke('performance:rendererTrace', payload),
  onBackgroundTasksChanged: (callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload)
    ipcRenderer.on('background-tasks:changed', listener)
    return () => ipcRenderer.removeListener('background-tasks:changed', listener)
  },
  getSystemInstalledFonts: (): Promise<SystemInstalledFont[]> => invoke('fonts:getSystemInstalledFonts'),
  scanSystemInstalledFonts: (): Promise<ScanResult> => invoke('fonts:scanSystemInstalledFonts'),
  compareFontInstalled: (item: FontItem): Promise<InstallCompareResult> => invoke('fonts:compareInstalled', item),
  compareFontsInstalled: (items: FontItem[], options?: InstallCompareOptions): Promise<Record<string, InstallCompareResult>> => invoke('fonts:compareManyInstalled', items, options),
  refreshInstallStatusIndex: (options?: InstallCompareOptions): Promise<InstallStatusRefreshResult> => invoke('fonts:refreshInstallStatusIndex', options),
  startInstallStatusRefreshIndex: (options?: InstallCompareOptions): Promise<InstallStatusRefreshStartResult> => invoke('fonts:startInstallStatusRefreshIndex', options),
  getInstallStatusIndex: (items: FontItem[]): Promise<{ results: Record<string, InstallCompareResult>; missingIds: string[] }> => invoke('fonts:getInstallStatusIndex', items),
  installSystem: (item: FontItem): Promise<InstallResult> => invoke('fonts:installSystem', item),
  uninstallSystem: (item: FontItem): Promise<InstallResult> => invoke('fonts:uninstallSystem', item),
  deleteFontFiles: (items: FontItem[], watchedFolders: string[]): Promise<FontDeleteResult> => invoke('fonts:deleteFiles', items, watchedFolders),
  setDeleteProtection: (items: FontItem[], watchedFolders: string[], protect: boolean): Promise<FontProtectionResult> => invoke('fonts:setDeleteProtection', items, watchedFolders, protect),
  setFavorite: (items: FontItem[], watchedFolders: string[], favorite: boolean): Promise<FontProtectionResult> => invoke('fonts:setFavorite', items, watchedFolders, favorite),
  setLocalTags: (item: FontItem, tagNames: string[]): Promise<FontTagUpdateResult> => invoke('fonts:setLocalTags', item, tagNames),
  setLocalTagsBatch: (items: FontTagBatchItem[]): Promise<FontTagUpdateResult> => invoke('fonts:setLocalTagsBatch', items),
  deleteLocalTag: (tagName: string): Promise<FontTagUpdateResult> => invoke('fonts:deleteLocalTag', tagName),
  setSharedTags: (items: FontItem[], watchedFolders: string[], tagNames: string[]): Promise<FontTagUpdateResult> => invoke('fonts:setSharedTags', items, watchedFolders, tagNames),
  setSharedTagsBatch: (items: FontTagBatchItem[], watchedFolders: string[]): Promise<FontTagUpdateResult> => invoke('fonts:setSharedTagsBatch', items, watchedFolders),
  renameSharedTag: (oldTagName: string, newTagName: string, watchedFolders: string[]): Promise<FontTagUpdateResult> => invoke('fonts:renameSharedTag', oldTagName, newTagName, watchedFolders),
  deleteSharedTag: (tagName: string, watchedFolders: string[]): Promise<FontTagUpdateResult> => invoke('fonts:deleteSharedTag', tagName, watchedFolders),
  activateFont: (item: FontItem): Promise<InstallResult> => invoke('fonts:activateFont', item),
  activateFonts: (items: FontItem[]): Promise<FontActivationBatchResult> => invoke('fonts:activateFonts', items),
  deactivateFont: (item: FontItem): Promise<InstallResult> => invoke('fonts:deactivateFont', item),
  deactivateFonts: (items: FontItem[]): Promise<FontActivationBatchResult> => invoke('fonts:deactivateFonts', items),
  installCurrentUser: (item: FontItem): Promise<InstallResult> => invoke('fonts:installCurrentUser', item),
  uninstallManaged: (item: FontItem): Promise<InstallResult> => invoke('fonts:uninstallManaged', item),
  toFontUrl: (filePath: string): Promise<string> => Promise.resolve(fontPathToProtocolUrl(filePath)),
  readPreviewFontData: (item: FontItem): Promise<ArrayBuffer> => invoke('fonts:readPreviewFontData', item),
  renderPreviewImage: (item: FontItem, text: string, fontSize: number, width: number, height: number): Promise<string> => invoke('fonts:renderPreviewImage', item, text, fontSize, width, height),
  getCachedPreviewImage: (item: FontItem, text: string, fontSize: number, width: number, height: number): Promise<string> => invoke('fonts:getCachedPreviewImage', item, text, fontSize, width, height),
  getCachedPreviewImages: (items: FontItem[], text: string, fontSize: number, width: number, height: number): Promise<Record<string, string>> => invoke('fonts:getCachedPreviewImages', items, text, fontSize, width, height),
  ensurePreviewCache: (item: FontItem, text: string, fontSize: number, width: number, height: number): Promise<{ ok: boolean; cached: boolean; storage?: 'root' | 'fallback' | 'local'; message?: string }> => invoke('fonts:ensurePreviewCache', item, text, fontSize, width, height),
  getPreviewCacheStatus: (items: FontItem[], text: string, fontSize: number, width: number, height: number): Promise<Record<string, boolean>> => invoke('fonts:getPreviewCacheStatus', items, text, fontSize, width, height),
  showItemInFolder: (filePath: string): Promise<boolean> => invoke('shell:showItemInFolder', filePath),
  windowMinimize: (): Promise<boolean> => invoke('app-window:minimize'),
  windowToggleMaximize: (): Promise<boolean> => invoke('app-window:toggleMaximize'),
  windowClose: (): Promise<boolean> => invoke('app-window:close'),
  onWindowFlushBeforeClose: (callback: (payload: { requestId: number }) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: { requestId: number }): void => callback(payload)
    ipcRenderer.on('app-window:flush-before-close', listener)
    return () => ipcRenderer.removeListener('app-window:flush-before-close', listener)
  },
  completeWindowCloseFlush: (requestId: number, saved: boolean): Promise<boolean> => invoke('app-window:flushComplete', requestId, saved),
  notifyRendererReady: (): Promise<boolean> => invoke('app-window:rendererReady')
}

contextBridge.exposeInMainWorld('hfm', api)

export type HfmApi = typeof api
