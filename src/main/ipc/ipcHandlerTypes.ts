import type {
FontItem,
FontQueryRequest,
FontTagBatchItem,
InstallCompareOptions,
LibraryState,
} from "../../shared/types";
import type { BackgroundTaskStatus } from "../tasks/backgroundTasks";

export type RendererPerformanceEventPayload = {
  source?: string;
  kind?: string;
  label?: string;
  severity?: string;
  durationMs?: number;
  timestamp?: number;
  page?: string;
  details?: Record<string, unknown>;
}

export type IpcInvokeHandler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => unknown | Promise<unknown>

export type IpcHandleRegistrar = (channel: string, handler: IpcInvokeHandler) => void

export interface IpcHandlerRuntime {
  appendLog?: (message: string) => void;
  reportPerformanceEvent?: (payload: RendererPerformanceEventPayload) => unknown;
  assertFeatureForChannel?: (channel: string) => void;
  getLicenseStatus?: () => unknown;
  loadLibrary: () => unknown | Promise<unknown>;
  loadLibraryShell: () => unknown | Promise<unknown>;
  saveLibrary: (state: LibraryState) => unknown | Promise<unknown>;
  scanFoldersManaged: (
    folders: string[],
    knownFonts?: FontItem[],
  ) => unknown | Promise<unknown>;
  cancelActiveFontScan: (reason?: string) => unknown;
  activeFontScanStatus: () => unknown;
  loadFolderCache: (folders: string[]) => unknown | Promise<unknown>;
  searchFontsInLibrary: (
    keyword: string,
    limit?: number,
  ) => unknown | Promise<unknown>;
  queryFontsInLibrary: (
    request: FontQueryRequest,
  ) => unknown | Promise<unknown>;
  queryFontPageInLibrary: (
    request: FontQueryRequest,
  ) => unknown | Promise<unknown>;
  checkSharedMetadataUpdates: (
    reason?: string,
  ) => unknown | Promise<unknown>;
  getFontMetricsFromLibrary: () => unknown | Promise<unknown>;
  startWatchingFolders: (folders: string[]) => unknown | Promise<unknown>;
  refreshWatchedFolder: (
    folderPath: string,
    rootPath?: string,
  ) => unknown | Promise<unknown>;
  getCacheStats: () => unknown | Promise<unknown>;
  cacheArchitectureInfo: () => unknown | Promise<unknown>;
  getMigrationDiagnostics?: () => unknown | Promise<unknown>;
  clearMigrationDiagnostics?: () => unknown | Promise<unknown>;
  readSharedMetadataFrontendDiagnostics?: (options?: { roots?: string[]; synchronize?: boolean; includeRepairDryRun?: boolean }) => unknown | Promise<unknown>;
  repairSharedMetadataFromFrontend?: (options?: { roots?: string[]; apply?: boolean; synchronizeAfterRepair?: boolean; repairInvalidTagJson?: boolean; purgeInvalidTagOps?: boolean; archiveOrphanTagOps?: boolean; purgeArchivedOrphanTagOps?: boolean; orphanArchiveReason?: string }) => unknown | Promise<unknown>;
  readSharedIndexSnapshotFrontendDiagnostics?: () => unknown | Promise<unknown>;
  repairSharedIndexSnapshotFromFrontend?: (options?: { apply?: boolean }) => unknown | Promise<unknown>;
  clearScanCache: () => unknown | Promise<unknown>;
  clearPreviewCache: () => unknown | Promise<unknown>;
  runDatabaseHealthCheck: () => unknown | Promise<unknown>;
  createDatabaseBackup: (reason?: string) => unknown | Promise<unknown>;
  runDatabaseMaintenance: (options: {
    createBackup: boolean;
    backupReason: string;
  }) => unknown | Promise<unknown>;
  restoreLatestApplicationDatabase: (
    label: "library" | "tasks" | "preview",
  ) => unknown | Promise<unknown>;
  listBackgroundTaskSummaries: (
    status?: BackgroundTaskStatus,
    limit?: number,
  ) => unknown | Promise<unknown>;
  runBackgroundTaskSchedulerOnce: () => Promise<unknown>;
  backgroundTaskSchedulerStatus: () => unknown;
  markRendererUserActivity: (durationMs?: number, reason?: string) => unknown;
  reportRendererLongTask: (payload: { durationMs?: number; name?: string; startTime?: number; source?: string }) => unknown;
  getSystemInstalledFonts: () => unknown | Promise<unknown>;
  scanSystemInstalledFonts: () => unknown | Promise<unknown>;
  compareFontInstalled: (item: FontItem) => unknown | Promise<unknown>;
  compareFontsInstalled: (
    items: FontItem[],
    options?: InstallCompareOptions,
  ) => unknown | Promise<unknown>;
  refreshInstallStatusIndex: (
    options: InstallCompareOptions,
    runtimeOptions: { emitProgress: boolean },
  ) => unknown | Promise<unknown>;
  startInstallStatusRefreshIndex: (
    options: InstallCompareOptions,
  ) => unknown | Promise<unknown>;
  getInstallStatusIndexSnapshot: (
    items: FontItem[],
  ) => unknown | Promise<unknown>;
  installFontSystemWide: (item: FontItem) => unknown | Promise<unknown>;
  uninstallFontSystemWide: (item: FontItem) => unknown | Promise<unknown>;
  deleteFontFilesToTrash: (
    items: FontItem[],
    watchedFolders: string[],
  ) => unknown | Promise<unknown>;
  setFontDeleteProtectionInIndex: (
    items: FontItem[],
    watchedFolders: string[],
    protect: boolean,
  ) => unknown | Promise<unknown>;
  setSharedFontFavoriteInIndex: (
    items: FontItem[],
    watchedFolders: string[],
    favorite: boolean,
  ) => unknown | Promise<unknown>;
  setLocalFontTags: (
    item: FontItem,
    tagNames: string[],
  ) => unknown | Promise<unknown>;
  setLocalFontTagsBatch: (
    items: FontTagBatchItem[],
  ) => unknown | Promise<unknown>;
  deleteLocalFontTag: (tagName: string) => unknown | Promise<unknown>;
  setSharedFontTagsInIndex: (
    items: FontItem[],
    watchedFolders: string[],
    tagNames: string[],
  ) => unknown | Promise<unknown>;
  setSharedFontTagsBatchInIndex: (
    items: FontTagBatchItem[],
    watchedFolders: string[],
  ) => unknown | Promise<unknown>;
  renameSharedFontTagInIndex: (
    oldTagName: string,
    newTagName: string,
    watchedFolders: string[],
  ) => unknown | Promise<unknown>;
  deleteSharedFontTagInIndex: (
    tagName: string,
    watchedFolders: string[],
  ) => unknown | Promise<unknown>;
  activateFontSession: (item: FontItem) => unknown | Promise<unknown>;
  activateFontSessionsBatch: (items: FontItem[]) => unknown | Promise<unknown>;
  deactivateFontSession: (item: FontItem) => unknown | Promise<unknown>;
  deactivateFontSessionsBatch: (
    items: FontItem[],
  ) => unknown | Promise<unknown>;
  installFontForCurrentUser: (item: FontItem) => unknown | Promise<unknown>;
  uninstallManagedFont: (item: FontItem) => unknown | Promise<unknown>;
  readPreviewFontData: (item: FontItem) => unknown | Promise<unknown>;
  renderFontPreviewImage: (
    item: FontItem,
    text: string,
    fontSize: number,
    width: number,
    height: number,
  ) => unknown | Promise<unknown>;
  readCachedFontPreviewImage: (
    item: FontItem,
    text: string,
    fontSize: number,
    width: number,
    height: number,
  ) => unknown | Promise<unknown>;
  readCachedFontPreviewImages: (
    items: FontItem[],
    text: string,
    fontSize: number,
    width: number,
    height: number,
  ) => unknown | Promise<unknown>;
  ensureFontPreviewCache: (
    item: FontItem,
    text: string,
    fontSize: number,
    width: number,
    height: number,
  ) => unknown | Promise<unknown>;
  getPreviewCacheStatus: (
    items: FontItem[],
    text: string,
    fontSize: number,
    width: number,
    height: number,
  ) => unknown | Promise<unknown>;
  createPhysicalFolder: (
    parentPath: string,
    name: string,
  ) => unknown | Promise<unknown>;
  renamePhysicalFolder: (
    folderPath: string,
    name: string,
  ) => unknown | Promise<unknown>;
  listPhysicalFolderTree: (folders: string[]) => unknown | Promise<unknown>;
  moveFontFileToFolder: (
    item: FontItem,
    targetFolder: string,
  ) => unknown | Promise<unknown>;
  moveFontFilesToFolder?: (
    items: FontItem[],
    targetFolder: string,
  ) => unknown | Promise<unknown>;
}
