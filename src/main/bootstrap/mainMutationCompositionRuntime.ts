import type { FontIndexChangePayload, FontItem, FontTagBatchItem, FontTagUpdateResult } from '../../shared/types';
import { createFontActivationRuntime } from '../activation/fontActivationRuntime';
import { createMainActivationInstallStatusSaveRuntime } from '../activation/mainActivationInstallStatusSaveRuntime';
import { APP_NAME } from '../app/appRuntimeConfig';
import { FONT_EXTENSIONS } from '../bootstrap/mainIndexConstants';
import { createFontMoveTransactionRuntime } from '../folders/fontMoveTransactionRuntime';
import { createPhysicalFolderActions, pathInsideFolder } from '../folders/physicalFolders';
import { createCurrentUserManagedInstallRuntime } from '../install/currentUserManagedInstallRuntime';
import { createManagedFontOwnershipRuntime } from '../install/managedFontOwnershipRuntime';
import { createSystemFontInstallRuntime } from '../install/systemFontInstallRuntime';
import { isCleanWindowsDefaultCandidate, isCleanWindowsDefaultFontName, isCleanWindowsDefaultItem } from '../install/windowsDefaultFonts';
import { createSharedFontMetadataMutations } from '../library/sharedFontMetadataMutations';
import { createSharedKnownTagsRuntime } from '../library/sharedKnownTagsRuntime';
import { createSharedMetadataMergedIndexSyncRuntime } from '../library/sharedMetadataMergedIndexSyncRuntime';
import type { createTagMutationWriteProtocolRuntime } from '../library/tagMutationWriteProtocolRuntime';
import { normalizePathForCacheCompare } from '../path/cachePath';
import { isPathInsideAnyRoot, uniqueResolvedFolders } from '../path/fontPathPolicy';
import type { MainMutationCompositionRuntime } from './mainCompositionContracts';
import type { MainOperationsFeedback } from './mainCompositionFeedback';
import type { createMainCoreCompositionRuntime } from './mainCoreCompositionRuntime';
import type { createMainDataCompositionRuntime } from './mainDataCompositionRuntime';
type Core = ReturnType<typeof createMainCoreCompositionRuntime>;
type Data = ReturnType<typeof createMainDataCompositionRuntime>;

export interface MainMutationCompositionOptions {
  tags: {
    tagMutationWriteProtocolRuntime: ReturnType<typeof createTagMutationWriteProtocolRuntime>;
  };
  storage: Pick<Data['storage'],
    | 'setLocalFontTagsBase'
    | 'invalidateSharedFontRuntimeCaches'
    | 'setLocalFontTagsBatchBase'
    | 'deleteLocalFontTagBase'
    | 'saveInstallStatusIndex'
    | 'appWatchedFolders'
    | 'rootForFontPath'
    | 'clearInstalledFontsMemoryCache'
    | 'getSystemInstalledFontsCached'
    | 'readInstallStatusIndex'
    | 'getSystemInstalledFonts'
    | 'sharedMetadataDbPathForRoot'
    | 'openStableSqliteDb'
    | 'closeSqliteDb'
    | 'openLibraryDb'
    | 'loadLibraryShellFromSqlite'
    | 'updateSharedFontMetadataEntries'
    | 'removeSharedTagFromMetadataIndexes'
    | 'renameSharedTagInMetadataIndexes'
    | 'saveLibrary'
  >;
  query: Pick<Data['query'],
    | 'syncMergedIndexAfterInstallStatusRefresh'
    | 'clearFontQueryCaches'
    | 'syncMergedIndexForRootIncremental'
    | 'syncMergedIndexForRootSnapshot'
    | 'findFontItemInRootIndexes'
  >;
  logging: Pick<Core['logging'],
    | 'appendStartupLog'
  >;
  paths: Pick<Core['paths'],
    | 'dataPath'
    | 'dataRoot'
    | 'exists'
  >;
  windows: Pick<Core['windows'],
    | 'ensureWindows'
    | 'currentUserFontsDir'
    | 'loadTemporaryActiveFonts'
    | 'saveTemporaryActiveFonts'
    | 'removeFontResourceSession'
    | 'removeFontResourceSessionBatch'
    | 'addFontResourceSessionBatch'
    | 'writeFontRegistryValuesHKCUBatch'
    | 'deleteFontRegistryValuesHKCUBatch'
    | 'deleteRegistryValueHKCU'
    | 'requestFontRefresh'
    | 'advancedFontRefresh'
    | 'addFontResourceSession'
    | 'scheduleBackgroundFontRefreshTail'
    | 'windowsFontsDir'
    | 'authorizeManagedFontDelete'
    | 'broadcastFontChange'
    | 'authorizePhysicalFolderParent'
    | 'authorizePhysicalFolderRename'
    | 'resolveExistingFontFilePath'
    | 'authorizeFontMoveSource'
    | 'authorizeFontMoveTarget'
    | 'authorizeFontMoveDestination'
  >;
  comparison: Pick<Core['comparison'],
    | 'isTemporaryActiveInstalledRecord'
    | 'compareFontInstalledWithList'
    | 'safeTemporaryActiveFontName'
    | 'temporaryActiveRegistryNameFor'
    | 'registryNameFor'
    | 'normalizeCompareText'
    | 'safeManagedFontName'
  >;
  performance: Pick<Core['performance'],
    | 'withGlobalIo'
  >;
  host: Pick<Core,
    | 'delayToEventLoop'
  >;
  feedback: {
    refreshWatchedFolder: MainOperationsFeedback['refreshWatchedFolder'];
    sendFontIndexChanged: (payload: FontIndexChangePayload) => void;
  };
  rustCoreWorkerRuntime: Pick<Core['rustCoreWorkerRuntime'], 'runRustFontActivationFiles' | 'runRustSharedMetadataKnownTags' | 'runRustPhysicalFolderTree'>;
}

export function createMainMutationCompositionRuntime(options: MainMutationCompositionOptions) {
  const { tagMutationWriteProtocolRuntime } = options.tags;
  const {
    setLocalFontTagsBase,
    invalidateSharedFontRuntimeCaches,
    setLocalFontTagsBatchBase,
    deleteLocalFontTagBase,
    saveInstallStatusIndex,
    appWatchedFolders,
    rootForFontPath,
    clearInstalledFontsMemoryCache,
    getSystemInstalledFontsCached,
    readInstallStatusIndex,
    getSystemInstalledFonts,
    sharedMetadataDbPathForRoot,
    openStableSqliteDb,
    closeSqliteDb,
    openLibraryDb,
    loadLibraryShellFromSqlite,
    updateSharedFontMetadataEntries,
    removeSharedTagFromMetadataIndexes,
    renameSharedTagInMetadataIndexes,
    saveLibrary,
  } = options.storage;
  const {
    syncMergedIndexAfterInstallStatusRefresh,
    clearFontQueryCaches,
    syncMergedIndexForRootIncremental,
    syncMergedIndexForRootSnapshot,
    findFontItemInRootIndexes,
  } = options.query;
  const { appendStartupLog } = options.logging;
  const { dataPath, dataRoot, exists } = options.paths;
  const {
    ensureWindows,
    currentUserFontsDir,
    loadTemporaryActiveFonts,
    saveTemporaryActiveFonts,
    removeFontResourceSession,
    removeFontResourceSessionBatch,
    addFontResourceSessionBatch,
    writeFontRegistryValuesHKCUBatch,
    deleteFontRegistryValuesHKCUBatch,
    deleteRegistryValueHKCU,
    requestFontRefresh,
    advancedFontRefresh,
    addFontResourceSession,
    scheduleBackgroundFontRefreshTail,
    windowsFontsDir,
    authorizeManagedFontDelete,
    broadcastFontChange,
    authorizePhysicalFolderParent,
    authorizePhysicalFolderRename,
    resolveExistingFontFilePath,
    authorizeFontMoveSource,
    authorizeFontMoveTarget,
    authorizeFontMoveDestination,
  } = options.windows;
  const {
    isTemporaryActiveInstalledRecord,
    compareFontInstalledWithList,
    safeTemporaryActiveFontName,
    temporaryActiveRegistryNameFor,
    registryNameFor,
    normalizeCompareText,
    safeManagedFontName,
  } = options.comparison;
  const { withGlobalIo } = options.performance;
  const { delayToEventLoop } = options.host;
  const { refreshWatchedFolder, sendFontIndexChanged } = options.feedback;
  const { rustCoreWorkerRuntime } = options;

  async function setLocalFontTags(
    item: FontItem,
    tagNames: string[],
  ): Promise<FontTagUpdateResult> {
    return tagMutationWriteProtocolRuntime.run({
      scope: "local",
      mutationKind: "local-tags-set",
      inputIds: [item?.id],
      action: () => setLocalFontTagsBase(item, tagNames),
      afterCommit: () => invalidateSharedFontRuntimeCaches(),
    });
  }

  async function setLocalFontTagsBatch(
    items: FontTagBatchItem[],
  ): Promise<FontTagUpdateResult> {
    return tagMutationWriteProtocolRuntime.run({
      scope: "local",
      mutationKind: "local-tags-batch-set",
      inputIds: (items || []).map((entry) => entry?.item?.id),
      action: () => setLocalFontTagsBatchBase(items || []),
      afterCommit: () => invalidateSharedFontRuntimeCaches(),
    });
  }

  async function deleteLocalFontTag(
    tagName: string,
  ): Promise<FontTagUpdateResult> {
    const cleanTag = String(tagName || "").trim();
    return tagMutationWriteProtocolRuntime.run({
      scope: "local",
      mutationKind: `local-tag-delete:${cleanTag}`,
      action: () => deleteLocalFontTagBase(tagName),
      afterCommit: () => invalidateSharedFontRuntimeCaches(),
    });
  }

  const {
    scheduleActivationInstallStatusSave,
    flushActivationInstallStatusSave,
    hasPendingActivationInstallStatusSave,
    hasInFlightActivationInstallStatusSave,
  } = createMainActivationInstallStatusSaveRuntime({
    saveInstallStatusIndex,
    appWatchedFolders,
    rootForFontPath,
    syncMergedIndexAfterInstallStatusRefresh: (folders) =>
      syncMergedIndexAfterInstallStatusRefresh(folders),
    clearFontQueryCaches,
    appendStartupLog,
  });

  const fontActivationRuntime = createFontActivationRuntime({
    appName: APP_NAME,
    dataPath,
    dataRoot,
    ensureWindows,
    currentUserFontsDir,
    normalizePathForCacheCompare,
    isTemporaryActiveInstalledRecord,
    compareFontInstalledWithList,
    clearInstalledFontsMemoryCache,
    getSystemInstalledFontsCached,
    readInstallStatusIndex,
    saveInstallStatusIndex,
    scheduleActivationInstallStatusSave,
    loadTemporaryActiveFonts,
    saveTemporaryActiveFonts,
    safeTemporaryActiveFontName,
    temporaryActiveRegistryNameFor,
    removeFontResourceSession,
    removeFontResourceSessionBatch,
    addFontResourceSessionBatch,
    writeFontRegistryValuesHKCUBatch,
    deleteFontRegistryValuesHKCUBatch,
    deleteRegistryValueHKCU,
    requestFontRefresh,
    advancedFontRefresh,
    addFontResourceSession,
    scheduleBackgroundFontRefreshTail,
    withGlobalIo,
    delayToEventLoop,
    appendStartupLog,
    runRustFontActivationFiles: rustCoreWorkerRuntime.runRustFontActivationFiles,
  });

  const {
    activationTraceStep,
    activateFontSession,
    activateFontSessionsBatch,
    deactivateFontSession,
    deactivateFontSessionsBatch,
    cleanupTemporaryActiveFontsUntilEmpty,
    flushPendingTemporaryFontDeletes,
  } = fontActivationRuntime;

  const systemFontInstallRuntime = createSystemFontInstallRuntime({
    fontExtensions: FONT_EXTENSIONS,
    ensureWindows,
    currentUserFontsDir,
    windowsFontsDir,
    registryNameFor,
    normalizePathForCacheCompare,
    normalizeCompareText,
    isCleanWindowsDefaultFontName,
    isCleanWindowsDefaultCandidate,
    isCleanWindowsDefaultItem,
    isTemporaryActiveInstalledRecord,
    isPathInsideAnyRoot,
    getSystemInstalledFonts,
    getSystemInstalledFontsCached,
    clearInstalledFontsMemoryCache,
    writeFontRegistryValuesHKCUBatch,
    deleteFontRegistryValuesHKCUBatch,
    advancedFontRefresh,
    activationTraceStep,
    appendStartupLog,
  });

  const {
    installFontSystemWide,
    uninstallFontSystemWide,
    deleteFontFilesToTrash,
  } = systemFontInstallRuntime;

  const sharedKnownTagsRuntime = createSharedKnownTagsRuntime({
    uniqueResolvedFolders,
    sharedMetadataDbPathForRoot,
    exists,
    openSharedMetadataDb: async (rootPath: string) =>
      openStableSqliteDb(
        sharedMetadataDbPathForRoot(rootPath),
        "shared-metadata-known-tags",
      ),
    closeSqliteDb,
    openLibraryDb,
    loadLibraryShellFromSqlite,
    appendStartupLog,
    runRustSharedMetadataKnownTags:
      rustCoreWorkerRuntime.runRustSharedMetadataKnownTags,
  });

  const { refreshKnownSharedTagsFromMetadata, renameKnownSharedTagIfUnbound, deleteKnownSharedTagIfUnbound } = sharedKnownTagsRuntime;

  const sharedMetadataMergedIndexSyncRuntime =
    createSharedMetadataMergedIndexSyncRuntime({
      appendLog: appendStartupLog,
      normalizePathForCacheCompare,
      uniqueResolvedFolders,
      syncMergedIndexForRootIncremental,
      syncMergedIndexForRootSnapshot,
      sendFontIndexChanged: (payload: FontIndexChangePayload) =>
        sendFontIndexChanged(payload),
    });

  const sharedFontMetadataMutations = createSharedFontMetadataMutations({
    uniqueResolvedFolders,
    updateSharedFontMetadataEntries,
    removeSharedTagFromMetadataIndexes,
    renameSharedTagInMetadataIndexes,
    invalidateSharedFontRuntimeCaches,
    syncSharedMetadataItemsToMergedIndex:
      sharedMetadataMergedIndexSyncRuntime.syncSharedMetadataItemsToMergedIndex,
    syncSharedMetadataRootsToMergedIndex:
      sharedMetadataMergedIndexSyncRuntime.syncSharedMetadataRootsToMergedIndex,
    refreshKnownSharedTagsFromMetadata: async (folders, options) => {
      await refreshKnownSharedTagsFromMetadata(folders, options);
    },
    renameKnownSharedTagIfUnbound,
    deleteKnownSharedTagIfUnbound,
  });

  const {
    setFontDeleteProtectionInIndex,
    setSharedFontFavoriteInIndex,
    setSharedFontTagsInIndex: setSharedFontTagsInIndexBase,
    setSharedFontTagsBatchInIndex: setSharedFontTagsBatchInIndexBase,
    renameSharedFontTagInIndex: renameSharedFontTagInIndexBase,
    deleteSharedFontTagInIndex: deleteSharedFontTagInIndexBase,
  } = sharedFontMetadataMutations;

  async function setSharedFontTagsInIndex(
    items: FontItem[],
    watchedFolders: string[],
    tagNames: string[],
  ): Promise<FontTagUpdateResult> {
    return tagMutationWriteProtocolRuntime.run({
      scope: "shared",
      mutationKind: "shared-tags-set",
      inputIds: (items || []).map((item) => item?.id),
      action: () => setSharedFontTagsInIndexBase(items, watchedFolders, tagNames),
    });
  }

  async function setSharedFontTagsBatchInIndex(
    items: FontTagBatchItem[],
    watchedFolders: string[],
  ): Promise<FontTagUpdateResult> {
    return tagMutationWriteProtocolRuntime.run({
      scope: "shared",
      mutationKind: "shared-tags-batch-set",
      inputIds: (items || []).map((entry) => entry?.item?.id),
      action: () => setSharedFontTagsBatchInIndexBase(items, watchedFolders),
    });
  }

  async function renameSharedFontTagInIndex(
    oldTagName: string,
    newTagName: string,
    watchedFolders: string[],
  ): Promise<FontTagUpdateResult> {
    const cleanOld = String(oldTagName || "").trim();
    const cleanNew = String(newTagName || "").trim();
    return tagMutationWriteProtocolRuntime.run({
      scope: "shared",
      mutationKind: `shared-tag-rename:${cleanOld}->${cleanNew}`,
      action: () => renameSharedFontTagInIndexBase(oldTagName, newTagName, watchedFolders),
    });
  }

  async function deleteSharedFontTagInIndex(
    tagName: string,
    watchedFolders: string[],
  ): Promise<FontTagUpdateResult> {
    const cleanTag = String(tagName || "").trim();
    return tagMutationWriteProtocolRuntime.run({
      scope: "shared",
      mutationKind: `shared-tag-delete:${cleanTag}`,
      action: () => deleteSharedFontTagInIndexBase(tagName, watchedFolders),
    });
  }

  const managedFontOwnershipRuntime = createManagedFontOwnershipRuntime({
    currentUserFontsDir,
    safeManagedFontName,
    registryNameFor,
    normalizePathForCompare: normalizePathForCacheCompare,
    findFontItemInRootIndexes,
    authorizeManagedFontDelete,
  });

  const { installFontForCurrentUser, uninstallManagedFont } =
    createCurrentUserManagedInstallRuntime({
      ensureWindows,
      currentUserFontsDir,
      safeManagedFontName,
      registryNameFor,
      authorizeManagedFontRemoval:
        managedFontOwnershipRuntime.authorizeManagedFontRemoval,
      writeFontRegistryValuesHKCUBatch,
      deleteFontRegistryValuesHKCUBatch,
      broadcastFontChange,
    });

  const {
    createPhysicalFolder,
    renamePhysicalFolder,
    listPhysicalFolderTree,
  } = createPhysicalFolderActions({
    ensureWindows,
    appendStartupLog,
    authorizePhysicalFolderParent,
    authorizePhysicalFolderRename,
    reconcileWatchedRoot: (rootPath) => refreshWatchedFolder(rootPath, rootPath),
    runRustPhysicalFolderTree: rustCoreWorkerRuntime.runRustPhysicalFolderTree,
  });

  const { moveFontFileToFolder, moveFontFilesToFolder } =
    createFontMoveTransactionRuntime({
      ensureWindows,
      resolveExistingFontFilePath,
      isProtectedFontPath: (filePath) =>
        pathInsideFolder(filePath, windowsFontsDir()),
      appendStartupLog,
      fontExtensions: FONT_EXTENSIONS,
      authorizeFontMoveSource,
      authorizeFontMoveTarget,
      authorizeFontMoveDestination,
      reconcileWatchedRoot: (rootPath) => refreshWatchedFolder(rootPath, rootPath),
    });
  const capabilities: MainMutationCompositionRuntime['capabilities'] = {
    saveLibrary,
    installFontSystemWide,
    uninstallFontSystemWide,
    deleteFontFilesToTrash,
    setFontDeleteProtectionInIndex,
    setSharedFontFavoriteInIndex,
    setLocalFontTags,
    setLocalFontTagsBatch,
    deleteLocalFontTag,
    setSharedFontTagsInIndex,
    setSharedFontTagsBatchInIndex,
    renameSharedFontTagInIndex,
    deleteSharedFontTagInIndex,
    activateFontSession,
    activateFontSessionsBatch,
    deactivateFontSession,
    deactivateFontSessionsBatch,
    installFontForCurrentUser,
    uninstallManagedFont,
    createPhysicalFolder,
    renamePhysicalFolder,
    moveFontFileToFolder,
    moveFontFilesToFolder
  };
  const lifecycle: MainMutationCompositionRuntime['lifecycle'] = {
    cleanupTemporaryActiveFontsUntilEmpty,
    flushPendingTemporaryFontDeletes,
    flushActivationInstallStatusSave,
    hasPendingActivationInstallStatusSave,
    hasInFlightActivationInstallStatusSave
  };
  return { capabilities, lifecycle, listPhysicalFolderTree, refreshKnownSharedTagsFromMetadata };
}
