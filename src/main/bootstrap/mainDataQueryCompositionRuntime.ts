import type {
  FontItem,
  FontMetricsResult,
  FontQueryPageResult,
  FontQueryRequest,
  FontQueryResult,
  FontSearchResult,
} from "../../shared/types";
import { FONT_SEARCH_RESULT_LIMIT_DEFAULT } from "../bootstrap/mainIndexConstants";
import { getSqliteMeta, setSqliteMeta, sqliteTableExists } from "../db/sqliteHelpers";
import { pathInsideFolder } from "../folders/physicalFolders";
import { createMergedIndexPageRuntime } from "../indexing/mergedIndexPageRuntime";
import { createRootIndexCoordinator } from "../indexing/rootIndexCoordinator";
import { createFontMemoryQueryRuntime } from "../library/fontMemoryQueryRuntime";
import { createFontMetricsRuntime } from "../library/fontMetricsRuntime";
import { createFontPageQueryCacheRuntime } from "../library/fontPageQueryCacheRuntime";
import { createFontQueryFacadeRuntime, type FontQueryFacadeRuntime } from "../library/fontQueryFacadeRuntime";
import { createFontSearchRuntime } from "../library/fontSearchRuntime";
import { normalizePathForCacheCompare } from "../path/cachePath";
import {
  FONT_QUERY_PAGE_CACHE_MAX,
  FONT_QUERY_PAGE_CACHE_TTL_MS,
  FONT_QUERY_RESULT_CACHE_MAX,
  FONT_QUERY_RESULT_CACHE_TTL_MS,
  MERGED_INDEX_BACKGROUND_VALIDATE_INTERVAL_MS,
  MERGED_INDEX_SCHEMA_VERSION,
  MERGED_INDEX_STALE_FIRST_PAGE_ENABLED,
} from "../app/appRuntimeConfig";
import type { TagMetadataRevisionBarrierRuntime } from '../library/tagMetadataRevisionBarrierRuntime';
import type { createMainCoreCompositionRuntime } from './mainCoreCompositionRuntime';
import type { createMainDataStorageCompositionRuntime } from './mainDataStorageCompositionRuntime';
type Core = ReturnType<typeof createMainCoreCompositionRuntime>;
type Storage = ReturnType<typeof createMainDataStorageCompositionRuntime>;

export interface MainDataQueryOptions {
  appWatchedFolders: Storage['appWatchedFolders'];
  loadSharedFontsForFolders: Storage['loadSharedFontsForFolders'];
  loadSharedFontsForFoldersFresh: Storage['loadSharedFontsForFoldersFresh'];
  hydrateLocalTagsForFonts: Storage['hydrateLocalTagsForFonts'];
  isSystemInstalledRecord: Core['comparison']['isSystemInstalledRecord'];
  isPathInWindowsFonts: Core['comparison']['isPathInWindowsFonts'];
  appendStartupLog: Core['logging']['appendStartupLog'];
  tagMetadataRevisionBarrier: TagMetadataRevisionBarrierRuntime;
  rustCoreWorkerRuntime: Pick<Core['rustCoreWorkerRuntime'],
    'invalidateRustCoreSchedulerCaches' | 'cancelRustCoreSchedulerScopes' |
    'noteRustCoreSchedulerInteractiveActivity' | 'runRustMergedIndexPageQuery' |
    'runRustMergedIndexRebuild' | 'runRustMergedIndexSync' |
    'runRustMergedIndexIdsQuery' | 'runRustMergedIndexMetricsQuery'
  >;
  migrationDiagnosticsRuntime: Core['migrationDiagnosticsRuntime'];
  dataPath: Core['paths']['dataPath'];
  exists: Core['paths']['exists'];
  openStableSqliteDb: Storage['openStableSqliteDb'];
  openRootIndexDb: Storage['openRootIndexDb'];
  closeSqliteDb: Storage['closeSqliteDb'];
  installStatusDbPathForRoot: Storage['installStatusDbPathForRoot'];
  cacheKeyForRootFile: Storage['cacheKeyForRootFile'];
  dbQueryWorkerRuntime: Storage['dbQueryWorkerRuntime'];
  librarySqlitePath: Storage['librarySqlitePath'];
  openLibraryDb: Storage['openLibraryDb'];
  applySharedMetadataToMergedRows: Storage['applySharedMetadataToMergedRows'];
  sharedMetadataSignatureForRoot: Storage['sharedMetadataSignatureForRoot'];
  delayToEventLoop: Core['delayToEventLoop'];
  rootCacheDir: Storage['rootCacheDir'];
  rootIndexDbPath: Storage['rootIndexDbPath'];
  resolveActiveRootIndexDbPath: Storage['resolveActiveRootIndexDbPath'];
  openMachineInstallDbForRoot: Storage['openMachineInstallDbForRoot'];
  sqliteRowToScanEntry: Storage['sqliteRowToScanEntry'];
  cachedFontForRuntime: Storage['cachedFontForRuntime'];
  cacheEntryRuntimePath: Storage['cacheEntryRuntimePath'];
  getInstallStatusIndexSnapshot: Storage['getInstallStatusIndexSnapshot'];
  localTagsByFontIds: Storage['localTagsByFontIds'];
  loadLibraryShellFromSqlite: Storage['loadLibraryShellFromSqlite'];
  saveMetricsSnapshot: Storage['saveMetricsSnapshot'];
  readInstallStatusIndex: Storage['readInstallStatusIndex'];
}

export function createMainDataQueryCompositionRuntime(options: MainDataQueryOptions) {
  const {
    appWatchedFolders,
    loadSharedFontsForFolders,
    loadSharedFontsForFoldersFresh,
    hydrateLocalTagsForFonts,
    isSystemInstalledRecord,
    isPathInWindowsFonts,
    appendStartupLog,
    tagMetadataRevisionBarrier,
    rustCoreWorkerRuntime,
    migrationDiagnosticsRuntime,
    dataPath,
    exists,
    openStableSqliteDb,
    openRootIndexDb,
    closeSqliteDb,
    installStatusDbPathForRoot,
    cacheKeyForRootFile,
    dbQueryWorkerRuntime,
    librarySqlitePath,
    openLibraryDb,
    applySharedMetadataToMergedRows,
    sharedMetadataSignatureForRoot,
    delayToEventLoop,
    rootCacheDir,
    rootIndexDbPath,
    resolveActiveRootIndexDbPath,
    openMachineInstallDbForRoot,
    sqliteRowToScanEntry,
    cachedFontForRuntime,
    cacheEntryRuntimePath,
    getInstallStatusIndexSnapshot,
    localTagsByFontIds,
    loadLibraryShellFromSqlite,
    saveMetricsSnapshot,
    readInstallStatusIndex,
  } = options;
  let fontQueryFacadeRuntimeRef: FontQueryFacadeRuntime | null = null;

  function requireFontQueryFacadeRuntime(): FontQueryFacadeRuntime {
    if (!fontQueryFacadeRuntimeRef)
      throw new Error("font query facade runtime is not initialized");
    return fontQueryFacadeRuntimeRef;
  }

  const fontSearchRuntime = createFontSearchRuntime();

  const { inferFontSearchCategory } = fontSearchRuntime;

  const fontMemoryQueryRuntime = createFontMemoryQueryRuntime({
    resultCacheMax: FONT_QUERY_RESULT_CACHE_MAX,
    resultCacheTtlMs: FONT_QUERY_RESULT_CACHE_TTL_MS,
    appWatchedFolders,
    loadSharedFontsForFolders,
    loadSharedFontsForFoldersFresh,
    hydrateLocalTagsForFonts,
    hydrateInstallStatusForFonts,
    normalizePathForCacheCompare,
    isSystemInstalledRecord,
    isPathInWindowsFonts,
    inferFontSearchCategory,
  });

  const {
    invalidateFontQueryResultCache,
    sharedFontMatchesPathPrefixes,
    compareSharedFonts,
    cleanSharedFontsForQuery,
  } = fontMemoryQueryRuntime;

  const fontPageQueryCacheRuntime = createFontPageQueryCacheRuntime({
    pageCacheMax: FONT_QUERY_PAGE_CACHE_MAX,
    pageCacheTtlMs: FONT_QUERY_PAGE_CACHE_TTL_MS,
    queryUncached: queryFontPageInLibraryUncached,
    appendStartupLog,
    cacheKeySuffix: (request) =>
      tagMetadataRevisionBarrier.cacheKeySuffixForRequest(request),
  });

  const { invalidateFontQueryPageCache, queryFontPageInLibrary } =
    fontPageQueryCacheRuntime;

  function clearFontQueryCaches(): void {
    invalidateFontQueryResultCache();
    invalidateFontQueryPageCache();
    rustCoreWorkerRuntime.invalidateRustCoreSchedulerCaches([
      "--merged-index-query-page",
      "--merged-index-query-metrics",
      "--merged-index-query-ids",
      "--shared-metadata-signature",
    ]);
    rustCoreWorkerRuntime.cancelRustCoreSchedulerScopes([
      "page-query",
      "metrics",
      "ids-query",
      "shared-metadata-signature",
    ]);
    fontQueryFacadeRuntimeRef?.clearFontMetricsQueryCache();
    rustCoreWorkerRuntime.noteRustCoreSchedulerInteractiveActivity(
      "font-query-cache-clear",
    );
    migrationDiagnosticsRuntime.record({
      source: "font-query-cache",
      kind: "cache-clear",
      reason: "global-font-query-cache-clear",
    });
  }

  async function searchFontsInLibrary(
    keywordInput: string,
    limitInput?: number,
  ): Promise<FontSearchResult> {
    return requireFontQueryFacadeRuntime().searchFontsInLibrary(
      keywordInput,
      limitInput,
    );
  }

  async function hydrateInstallStatusForFonts(
    items: FontItem[],
  ): Promise<FontItem[]> {
    return requireFontQueryFacadeRuntime().hydrateInstallStatusForFonts(items);
  }

  const mergedIndexPageRuntime = createMergedIndexPageRuntime({
    dataPath,
    exists,
    openStableSqliteDb,
    openRootIndexDb,
    closeSqliteDb,
    getSqliteMeta,
    setSqliteMeta,
    sqliteTableExists,
    appendStartupLog,
    schemaVersion: MERGED_INDEX_SCHEMA_VERSION,
    staleFirstPageEnabled: MERGED_INDEX_STALE_FIRST_PAGE_ENABLED,
    backgroundValidateIntervalMs: MERGED_INDEX_BACKGROUND_VALIDATE_INTERVAL_MS,
    appWatchedFolders,
    activeRootIndexDbPathForRoot: (rootPath) =>
      rootIndexCoordinator.activeRootIndexDbPathForRoot(rootPath),
    installStatusDbPathForRoot,
    attachInstallStatusDbIfAvailable: (db, rootPath) =>
      rootIndexCoordinator.attachInstallStatusDbIfAvailable(db, rootPath),
    cacheKeyForRootFile,
    pathInsideFolder,
    normalizePathForCacheCompare,
    dbQueryWorkerRuntime,
    rustCoreWorkerRuntime,
    librarySqlitePath,
    openLibraryDb,
    rootIndexSqliteJsonAvailable: (db) =>
      rootIndexCoordinator.rootIndexSqliteJsonAvailable(db),
    fontFromRootIndexPageRow: (rootPath, row) =>
      rootIndexCoordinator.fontFromRootIndexPageRow(rootPath, row),
    hydrateLocalTagsForFonts,
    applySharedMetadataToMergedRows,
    sharedMetadataSignatureForRoot,
    delayToEventLoop,
    tagRevisionSnapshotForRequest: (request) =>
      tagMetadataRevisionBarrier.snapshotForRequest(request),
    onMergedIndexCommitted: ({ reason, sequence, revision }) => {
      clearFontQueryCaches();
      appendStartupLog(
        `local merged index commit invalidated query caches: reason=${reason}, sequence=${sequence}, revision=${revision}`,
      );
    },
  });

  const {
    mergedIndexDbPath,
    openMergedIndexDb,
    scheduleMergedIndexBackgroundValidation,
    checkMergedIndexExternalChanges,
    syncMergedIndexAfterInstallStatusRefresh,
    syncMergedIndexForRootIncremental,
    syncMergedIndexForRootSnapshot,
    queryFontPageFromMergedIndexWorker,
    queryFontPageFromMergedIndex,
  } = mergedIndexPageRuntime;

  const rootIndexCoordinator = createRootIndexCoordinator({
    exists,
    rootCacheDir,
    rootIndexDbPath,
    resolveActiveRootIndexDbPath,
    installStatusDbPathForRoot,
    openMachineInstallDbForRoot,
    closeSqliteDb,
    openRootIndexDb,
    sqliteRowToScanEntry,
    cachedFontForRuntime,
    cacheEntryRuntimePath,
    hydrateLocalTagsForFonts,
    compareSharedFonts,
    appWatchedFolders,
    appendStartupLog,
  });

  const { findFontItemInRootIndexes, queryFontPageFromRootIndexes } =
    rootIndexCoordinator;

  async function mainProcessFontIndexContains(identity: {
    comparePath: string;
  }): Promise<boolean> {
    return Boolean(await findFontItemInRootIndexes("", identity.comparePath));
  }

  async function queryFontPageInLibraryUncached(
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ): Promise<FontQueryPageResult> {
    return requireFontQueryFacadeRuntime().queryFontPageInLibraryUncached(
      request,
      limit,
      offset,
    );
  }

  async function queryFontsInLibrary(
    requestInput: FontQueryRequest,
  ): Promise<FontQueryResult> {
    return requireFontQueryFacadeRuntime().queryFontsInLibrary(requestInput);
  }

  const fontMetricsFallbackRuntime = createFontMetricsRuntime({
    appWatchedFolders,
    loadSharedFontsForFolders,
    hydrateInstallStatusForFonts,
    getInstallStatusIndexSnapshot,
    localTagsByFontIds,
    openLibraryDb,
    loadLibraryShellFromSqlite,
    saveMetricsSnapshot,
    inferFontSearchCategory,
    sharedFontMatchesPathPrefixes,
  });

  fontQueryFacadeRuntimeRef = createFontQueryFacadeRuntime({
    fontSearchResultLimitDefault: FONT_SEARCH_RESULT_LIMIT_DEFAULT,
    mergedIndexSchemaVersion: MERGED_INDEX_SCHEMA_VERSION,
    appendLog: appendStartupLog,
    appWatchedFolders,
    cleanSharedFontsForQuery,
    hydrateLocalTagsForFonts,
    readInstallStatusIndex,
    queryFontPageFromMergedIndexWorker,
    queryFontPageFromMergedIndex,
    queryFontPageFromRootIndexes,
    scheduleMergedIndexBackgroundValidation,
    dbQueryWorkerRuntime,
    rustCoreWorkerRuntime,
    mergedIndexDbPath,
    librarySqlitePath,
    fontMetricsFallbackRuntime,
    tagMetadataRevisionBarrier,
    migrationDiagnostics: migrationDiagnosticsRuntime,
  });

  async function getFontMetricsFromLibrary(): Promise<FontMetricsResult> {
    return requireFontQueryFacadeRuntime().getFontMetricsFromLibrary();
  }
  return {

    queryFontPageInLibrary,

    clearFontQueryCaches,

    searchFontsInLibrary,

    openMergedIndexDb: openMergedIndexDb as (...args: Parameters<typeof openMergedIndexDb>) => Promise<unknown>,

    checkMergedIndexExternalChanges,

    syncMergedIndexAfterInstallStatusRefresh,

    syncMergedIndexForRootIncremental,

    syncMergedIndexForRootSnapshot,

    findFontItemInRootIndexes,

    mainProcessFontIndexContains,

    queryFontsInLibrary,

    getFontMetricsFromLibrary,

  };
}
