import { openTagFontSnapshots } from '../library/tagFontSnapshotRuntime';
import { createFontProtectionAuthorityRuntime, readSharedFontProtection } from '../install/fontProtectionAuthorityRuntime';
import { withSharedLeaseLocks } from '../storage/runtime/sharedLeaseLockRuntime';
import { sharedFileSystem as protectionFs } from '../path/sharedFileSystemRuntime';
import { findBestWatchedRootForFile } from '../path/fontPathPolicy';
import { sharedSqliteReadSnapshot } from '../path/sharedFileSystemRuntime';
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
    | 'setLocalFontFavorite'
    | 'setLocalFontProtection'
    | 'readLocalFontProtection'
    | 'fontProtectionRoots'
    | 'clearLocalFontProtection'
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
    setLocalFontFavorite,
    setLocalFontProtection,
    readLocalFontProtection,
    fontProtectionRoots,
    clearLocalFontProtection,
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
    applyPendingActivationState,
    flushActivationInstallStatusSave,
    hasPendingActivationInstallStatusSave,
    hasInFlightActivationInstallStatusSave,
  } = createMainActivationInstallStatusSaveRuntime({
    readInstallStatusIndex,
    saveInstallStatusIndex,
    appWatchedFolders,
    rootForFontPath,
    syncMergedIndexAfterInstallStatusRefresh: (folders, items) =>
      syncMergedIndexAfterInstallStatusRefresh(folders, items),
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
    readFontCleanupRemnants,
    runFontCleanupAction,
    activateFontSession,
    activateFontSessionsBatch,
    deactivateFontSession,
    deactivateFontSessionsBatch,
    cleanupTemporaryActiveFontsUntilEmpty,
    flushPendingTemporaryFontDeletes,
  } = fontActivationRuntime;

  const protectionAuthority = createFontProtectionAuthorityRuntime({
    roots: fontProtectionRoots,
    log: appendStartupLog,
    lock: (items, roots, action) => {
      if (String(process.env.HFM_SHARED_LEASE_LOCKS || '').trim() === '0') throw new Error('保护锁已禁用，无法确认并发保护状态。');
      return withSharedLeaseLocks({
        operation: 'manual-font-protection',
        resourcePaths: [...new Set(items.map(item => findBestWatchedRootForFile(item.path, roots)).filter((root): root is string => !!root))].map(sharedMetadataDbPathForRoot),
        roots, ttlMs: 120000, appendStartupLog,
      }, action);
    },
    read: async (item, roots) => {
      if (await readLocalFontProtection(item)) return true;
      const root = findBestWatchedRootForFile(item.path, roots);
      if (!root) return false;
      // access must throw for offline/denied/missing authorities. Never create
      // a new empty database and interpret it as an unprotected font.
      await protectionFs.access(sharedMetadataDbPathForRoot(root));
      const db = await openMetadataReadSnapshot(root, 'manual-protection-authority');
      try {
        return readSharedFontProtection(db, item, root);
      } finally { closeSqliteDb(db); }
    },
  });

  const systemFontInstallRuntime = createSystemFontInstallRuntime({
    fontExtensions: FONT_EXTENSIONS,
    withFontProtection: protectionAuthority.guard,
    deactivateForFileDelete: deactivateFontSessionsBatch,
    persistUninstallResult: async item => {
      const state = await loadTemporaryActiveFonts();
      const active = state.records.filter(record => normalizePathForCacheCompare(record.sourcePath || '') === normalizePathForCacheCompare(item.path));
      const matches = active.map(record => ({ source: 'HKCU' as const, registryName: record.registryName, value: record.installPath, path: record.installPath, fileName: record.fileName }));
      scheduleActivationInstallStatusSave({ [item.id]: { installed: active.length > 0, by: active.length ? 'managed' : 'none', matches } }, new Map([[item.id, item]]), 'uninstall-verified');
      await flushActivationInstallStatusSave('uninstall-verified');
    },
    ensureWindows,
    currentUserFontsDir,
    windowsFontsDir,
    registryNameFor,
    normalizePathForCacheCompare,
    normalizeCompareText,
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

  async function openMetadataReadSnapshot(rootPath: string, label: string): Promise<any> {
    const dbPath = sharedMetadataDbPathForRoot(rootPath);
    const snapshot = await sharedSqliteReadSnapshot(dbPath);
    let db: any;
    try {
      db = openStableSqliteDb(snapshot?.path || dbPath, label);
      if (snapshot) {
        const close = db.close.bind(db);
        db.close = () => { try { return close(); } finally { void snapshot.dispose().catch(error => appendStartupLog(`metadata snapshot close failed: ${String(error)}`)); } };
      }
      return db;
    } catch (error) { await snapshot?.dispose(); throw error; }
  }
  const sharedKnownTagsRuntime = createSharedKnownTagsRuntime({
    uniqueResolvedFolders,
    sharedMetadataDbPathForRoot,
    exists,
    openSharedMetadataDb: async (rootPath: string) => openMetadataReadSnapshot(rootPath, "shared-metadata-known-tags"),
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
      openMetadataDb: async (root) => {
        const dbPath = sharedMetadataDbPathForRoot(root);
        return await exists(dbPath) ? openMetadataReadSnapshot(root, 'shared-metadata-changed-ids') : null;
      },
      closeMetadataDb: closeSqliteDb,
      sendFontIndexChanged: (payload: FontIndexChangePayload) =>
        sendFontIndexChanged(payload),
    });

  const sharedFontMetadataMutations = createSharedFontMetadataMutations({
    appendLog: appendStartupLog,
    syncSharedMetadataChangedIdsToMergedIndex: sharedMetadataMergedIndexSyncRuntime.syncSharedMetadataChangedIdsToMergedIndex,
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
      return refreshKnownSharedTagsFromMetadata(folders, options);
    },
    renameKnownSharedTagIfUnbound,
    deleteKnownSharedTagIfUnbound,
  });

  const {
    setFontDeleteProtectionInIndex: setSharedFontProtection,
    setSharedFontTagsInIndex: setSharedFontTagsInIndexBase,
    setSharedFontTagsBatchInIndex: setSharedFontTagsBatchInIndexBase,
    renameSharedFontTagInIndex: renameSharedFontTagInIndexBase,
    deleteSharedFontTagInIndex: deleteSharedFontTagInIndexBase,
  } = sharedFontMetadataMutations;

  async function setFontDeleteProtectionInIndexBase(items: FontItem[], _folders: string[], protect: boolean) {
    // Use persisted roots, never renderer-provided roots, to select the owner.
    const roots = await fontProtectionRoots();
    const shared = items.filter(item => isPathInsideAnyRoot(item.path, roots));
    const local = items.filter(item => !isPathInsideAnyRoot(item.path, roots));
    const result = { ok: true, updatedIds: [] as string[], failed: [] as Array<{ id: string; fileName: string; message: string }>, message: '' };
    for (const [targets, action] of [[shared, () => setSharedFontProtection(shared, roots, protect)], [local, () => setLocalFontProtection(local, protect)]] as const) {
      if (!targets.length) continue;
      try {
        const reply = await action();
        if (targets === shared) await clearLocalFontProtection(shared.filter(item => reply.updatedIds.includes(item.id)));
        result.updatedIds.push(...reply.updatedIds);
        result.failed.push(...reply.failed);
      } catch (error) {
        for (const item of targets) result.failed.push({ id: item.id, fileName: item.fileName, message: String(error) });
      }
    }
    result.ok = result.failed.length === 0;
    result.message = `${protect ? '加入保护' : '取消保护'} ${result.updatedIds.length} 个，失败 ${result.failed.length} 个。${result.failed[0]?.message || ''}`;
    appendStartupLog(`manual protection write: protect=${protect}, shared=${shared.length}, local=${local.length}, committed=${result.updatedIds.length}, failed=${result.failed.length}`);
    return result;
  }

  async function setFontDeleteProtectionInIndex(items: FontItem[], folders: string[], protect: boolean) {
    if (!items.length) return { ok: true, updatedIds: [], failed: [], message: '没有可更新的字体。' };
    return protectionAuthority.mutate(items, () => setFontDeleteProtectionInIndexBase(items, folders, protect));
  }

  async function setSharedFontTagsInIndex(
    items: FontItem[],
    watchedFolders: string[],
    tagNames: string[],
  ): Promise<FontTagUpdateResult> {
    return tagMutationWriteProtocolRuntime.run({
      scope: "shared",
      mutationKind: "shared-tags-set",
      inputIds: (items || []).map((item) => item?.id),
      action: async () => {
        openTagFontSnapshots(await openLibraryDb()).remember(items);
        return setSharedFontTagsInIndexBase(items, watchedFolders, tagNames);
      },
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
      action: async () => {
        openTagFontSnapshots(await openLibraryDb()).remember(items.map(entry => entry.item));
        return setSharedFontTagsBatchInIndexBase(items, watchedFolders);
      },
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
    // Preserve the existing registration port; its implementation is local-only.
    setSharedFontFavoriteInIndex: setLocalFontFavorite,
    setLocalFontTags,
    setLocalFontTagsBatch,
    deleteLocalFontTag,
    setSharedFontTagsInIndex,
    setSharedFontTagsBatchInIndex,
    renameSharedFontTagInIndex,
    deleteSharedFontTagInIndex,
    readFontCleanupRemnants,
    runFontCleanupAction,
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
  return { capabilities, lifecycle, listPhysicalFolderTree, refreshKnownSharedTagsFromMetadata, applyPendingActivationState, hasPendingActivationState: () => hasPendingActivationInstallStatusSave() || hasInFlightActivationInstallStatusSave() };
}
