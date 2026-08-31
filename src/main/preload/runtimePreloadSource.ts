export const runtimePreloadSource = `
const { contextBridge, ipcRenderer } = require('electron');

const PRELOAD_TRACE_ALWAYS = new Set([
  'library:load', 'library:loadShell', 'fonts:scanFolders', 'fonts:loadFolderCache',
  'fonts:refreshInstallStatusIndex', 'fonts:startInstallStatusRefreshIndex', 'folders:refreshWatched', 'folders:listPhysicalTree',
  'fonts:ensurePreviewCache', 'fonts:getPreviewCacheStatus', 'fonts:activateFonts', 'fonts:deactivateFonts', 'fonts:deleteFiles',
  'fonts:setLocalTagsBatch', 'fonts:setSharedTagsBatch', 'fonts:renameSharedTag', 'fonts:deleteLocalTag', 'fonts:deleteSharedTag', 'fonts:setFavorite', 'fonts:setDeleteProtection', 'fonts:moveFilesToFolder'
]);
const PRELOAD_VERBOSE = process.env.HFM_VERBOSE_LOGS === '1' || process.env.HFM_LOG_DETAIL === 'debug';
const PRELOAD_TRACE_SLOW_MS = PRELOAD_VERBOSE ? 80 : 120;
const PRELOAD_TRACE_ALWAYS_MIN_MS = PRELOAD_VERBOSE ? 0 : 25;
function summarizePreloadValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 120 ? value.slice(0, 120) + '…' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value === 'object') {
    const activeFilter = value.activeFilter && typeof value.activeFilter === 'object' ? value.activeFilter : undefined;
    return { type: 'object', keys: Object.keys(value).slice(0, 10), total: value.total, offset: value.offset, limit: value.limit, page: value.page, sidebarPage: value.sidebarPage, search: typeof value.search === 'string' ? value.search.slice(0, 80) : undefined, keyword: typeof value.keyword === 'string' ? value.keyword.slice(0, 80) : undefined, activeFilterKind: activeFilter ? activeFilter.kind : undefined, activeFilterName: activeFilter ? activeFilter.name : undefined, installStatus: value.installStatus, items: Array.isArray(value.items) ? value.items.length : undefined, fonts: Array.isArray(value.fonts) ? value.fonts.length : undefined };
  }
  return typeof value;
}
function reportPreloadTrace(payload) {
  ipcRenderer.invoke('performance:rendererTrace', payload).catch(() => undefined);
}
function fontPathToProtocolUrl(filePath) {
  const encodedPath = Buffer.from(String(filePath || ''), 'utf8').toString('base64url');
  return 'hfm-font://local/b64/' + encodedPath;
}
function invoke(channel, ...args) {
  const startedAt = Date.now();
  return ipcRenderer.invoke(channel, ...args).then((result) => {
    const durationMs = Date.now() - startedAt;
    if (!channel.startsWith('performance:') && ((PRELOAD_TRACE_ALWAYS.has(channel) && durationMs >= PRELOAD_TRACE_ALWAYS_MIN_MS) || durationMs >= PRELOAD_TRACE_SLOW_MS)) {
      reportPreloadTrace({ source: 'preload', kind: 'ipc-renderer', label: channel, severity: durationMs >= 350 ? 'warn' : durationMs >= PRELOAD_TRACE_SLOW_MS ? 'slow' : 'info', durationMs, timestamp: Date.now(), details: { args: args.map(summarizePreloadValue), result: summarizePreloadValue(result) } });
    }
    return result;
  }).catch((error) => {
    const durationMs = Date.now() - startedAt;
    if (!channel.startsWith('performance:')) reportPreloadTrace({ source: 'preload', kind: 'ipc-renderer-error', label: channel, severity: 'error', durationMs, timestamp: Date.now(), details: { error: error && error.message ? error.message : String(error) } });
    throw error;
  });
}

const api = {
  loadLibrary: () => invoke('library:load'),
  loadLibraryShell: () => invoke('library:loadShell'),
  saveLibrary: (state) => invoke('library:save', state),
  selectFontFolders: () => invoke('dialog:selectFontFolders'),
  scanFolders: (folders, knownFonts) => invoke('fonts:scanFolders', folders, knownFonts),
  cancelFontScan: (reason) => invoke('fonts:cancelScan', reason),
  getFontScanStatus: () => invoke('fonts:getScanStatus'),
  loadFolderCache: (folders) => invoke('fonts:loadFolderCache', folders),
  searchFonts: (keyword, limit) => invoke('fonts:search', keyword, limit),
  queryFonts: (request) => invoke('fonts:query', request),
  queryFontPage: (request) => invoke('fonts:queryPage', request),
  checkSharedMetadataUpdates: (reason) => invoke('fonts:checkSharedMetadataUpdates', reason),
  getFontMetrics: () => invoke('fonts:getMetrics'),
  watchFolders: (folders) => invoke('folders:watch', folders),
  refreshWatchedFolder: (folderPath, rootPath) => invoke('folders:refreshWatched', folderPath, rootPath),
  createPhysicalFolder: (parentPath, name) => invoke('folders:createPhysical', parentPath, name),
  renamePhysicalFolder: (folderPath, name) => invoke('folders:renamePhysical', folderPath, name),
  listPhysicalFolderTree: (folders) => invoke('folders:listPhysicalTree', folders),
  moveFontFileToFolder: (item, targetFolder) => invoke('fonts:moveFileToFolder', item, targetFolder),
  moveFontFilesToFolder: (items, targetFolder) => invoke('fonts:moveFilesToFolder', items, targetFolder),
  onFoldersChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('folders:changed', listener);
    return () => ipcRenderer.removeListener('folders:changed', listener);
  },
  onFontIndexChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('font-index:changed', listener);
    return () => ipcRenderer.removeListener('font-index:changed', listener);
  },
  onFontIndexProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('font-index:progress', listener);
    return () => ipcRenderer.removeListener('font-index:progress', listener);
  },
  onFontTagStateSignal: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('font-tags:stateSignal', listener);
    return () => ipcRenderer.removeListener('font-tags:stateSignal', listener);
  },
  onInstallStatusProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('install-status:progress', listener);
    return () => ipcRenderer.removeListener('install-status:progress', listener);
  },
  getCacheStats: () => invoke('cache:getStats'),
  getCacheArchitecture: () => invoke('cache:getArchitecture'),
  getSharedMetadataDiagnostics: (options) => invoke('sharedMetadata:getDiagnostics', options),
  repairSharedMetadata: (options) => invoke('sharedMetadata:repair', options),
  getSharedIndexSnapshotDiagnostics: () => invoke('sharedIndexSnapshots:getDiagnostics'),
  repairSharedIndexSnapshots: (options) => invoke('sharedIndexSnapshots:repair', options),
  clearScanCache: () => invoke('cache:clearScanCache'),
  clearPreviewCache: () => invoke('cache:clearPreviewCache'),
  runDatabaseHealthCheck: () => invoke('maintenance:healthCheck'),
  createDatabaseBackup: (reason) => invoke('maintenance:createBackup', reason),
  runDatabaseMaintenance: () => invoke('maintenance:run'),
  restoreLatestDatabaseBackup: (label) => invoke('maintenance:restoreLatestBackup', label),
  listBackgroundTasks: (status, limit) => invoke('tasks:list', status, limit),
  runBackgroundTasksNow: () => invoke('tasks:runNow'),
  getBackgroundTaskSchedulerStatus: () => invoke('tasks:getSchedulerStatus'),
  reportUserActivity: (durationMs, reason) => invoke('performance:userActivity', durationMs, reason),
  reportRendererLongTask: (payload) => invoke('performance:rendererLongTask', payload),
  reportPerformanceEvent: (payload) => invoke('performance:rendererTrace', payload),
  onBackgroundTasksChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('background-tasks:changed', listener);
    return () => ipcRenderer.removeListener('background-tasks:changed', listener);
  },
  getSystemInstalledFonts: () => invoke('fonts:getSystemInstalledFonts'),
  scanSystemInstalledFonts: () => invoke('fonts:scanSystemInstalledFonts'),
  compareFontInstalled: (item) => invoke('fonts:compareInstalled', item),
  compareFontsInstalled: (items, options) => invoke('fonts:compareManyInstalled', items, options),
  refreshInstallStatusIndex: (options) => invoke('fonts:refreshInstallStatusIndex', options),
  startInstallStatusRefreshIndex: (options) => invoke('fonts:startInstallStatusRefreshIndex', options),
  getInstallStatusIndex: (items) => invoke('fonts:getInstallStatusIndex', items),
  installSystem: (item) => invoke('fonts:installSystem', item),
  uninstallSystem: (item) => invoke('fonts:uninstallSystem', item),
  deleteFontFiles: (items, watchedFolders) => invoke('fonts:deleteFiles', items, watchedFolders),
  setDeleteProtection: (items, watchedFolders, protect) => invoke('fonts:setDeleteProtection', items, watchedFolders, protect),
  setFavorite: (items, watchedFolders, favorite) => invoke('fonts:setFavorite', items, watchedFolders, favorite),
  setLocalTags: (item, tagNames) => invoke('fonts:setLocalTags', item, tagNames),
  setLocalTagsBatch: (items) => invoke('fonts:setLocalTagsBatch', items),
  deleteLocalTag: (tagName) => invoke('fonts:deleteLocalTag', tagName),
  setSharedTags: (items, watchedFolders, tagNames) => invoke('fonts:setSharedTags', items, watchedFolders, tagNames),
  setSharedTagsBatch: (items, watchedFolders) => invoke('fonts:setSharedTagsBatch', items, watchedFolders),
  renameSharedTag: (oldTagName, newTagName, watchedFolders) => invoke('fonts:renameSharedTag', oldTagName, newTagName, watchedFolders),
  deleteSharedTag: (tagName, watchedFolders) => invoke('fonts:deleteSharedTag', tagName, watchedFolders),
  activateFont: (item) => invoke('fonts:activateFont', item),
  activateFonts: (items) => invoke('fonts:activateFonts', items),
  deactivateFont: (item) => invoke('fonts:deactivateFont', item),
  deactivateFonts: (items) => invoke('fonts:deactivateFonts', items),
  installCurrentUser: (item) => invoke('fonts:installCurrentUser', item),
  uninstallManaged: (item) => invoke('fonts:uninstallManaged', item),
  toFontUrl: (filePath) => Promise.resolve(fontPathToProtocolUrl(filePath)),
  readPreviewFontData: (item) => invoke('fonts:readPreviewFontData', item),
  renderPreviewImage: (item, text, fontSize, width, height) => invoke('fonts:renderPreviewImage', item, text, fontSize, width, height),
  getCachedPreviewImage: (item, text, fontSize, width, height) => invoke('fonts:getCachedPreviewImage', item, text, fontSize, width, height),
  getCachedPreviewImages: (items, text, fontSize, width, height) => invoke('fonts:getCachedPreviewImages', items, text, fontSize, width, height),
  ensurePreviewCache: (item, text, fontSize, width, height) => invoke('fonts:ensurePreviewCache', item, text, fontSize, width, height),
  getPreviewCacheStatus: (items, text, fontSize, width, height) => invoke('fonts:getPreviewCacheStatus', items, text, fontSize, width, height),
  showItemInFolder: (filePath) => invoke('shell:showItemInFolder', filePath),
  windowMinimize: () => invoke('app-window:minimize'),
  windowToggleMaximize: () => invoke('app-window:toggleMaximize'),
  windowClose: () => invoke('app-window:close'),
  onWindowFlushBeforeClose: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app-window:flush-before-close', listener);
    return () => ipcRenderer.removeListener('app-window:flush-before-close', listener);
  },
  completeWindowCloseFlush: (requestId, saved) => invoke('app-window:flushComplete', requestId, saved),
  notifyRendererReady: () => invoke('app-window:rendererReady')
};

contextBridge.exposeInMainWorld('hfm', api);
`
