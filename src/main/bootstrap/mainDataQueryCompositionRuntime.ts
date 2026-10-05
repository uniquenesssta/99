import { createTagRelinkAuthorizationRuntime } from '../library/tagRelinkAuthorizationRuntime';
import { createTagFontQueryRuntime, tagQueryScope } from '../library/tagFontQueryRuntime';
import { openTagFontSnapshots } from '../library/tagFontSnapshotRuntime';
import { createFontMemoryQueryMatcher } from '../library/fontMemoryQueryMatcherRuntime';
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
import { createFontMetricsRuntime, readLocalUserMetricsFromMergedIndex } from "../library/fontMetricsRuntime";
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
  applyPendingActivationState: (items: FontItem[]) => FontItem[];
  hasPendingActivationState?: () => boolean;
  appWatchedFolders: Storage['appWatchedFolders'];
  loadSharedFontsForFolders: Storage['loadSharedFontsForFolders'];
  loadSharedFontsForFoldersFresh: Storage['loadSharedFontsForFoldersFresh'];
  hydrateLocalTagsForFonts: Storage['hydrateLocalTagsForFonts'];
  hydrateLocalFavoritesForFonts: Storage['hydrateLocalFavoritesForFonts'];
  isSystemInstalledRecord: Core['comparison']['isSystemInstalledRecord'];
  isPathInWindowsFonts: Core['comparison']['isPathInWindowsFonts'];
  appendStartupLog: Core['logging']['appendStartupLog'];
  tagMetadataRevisionBarrier: TagMetadataRevisionBarrierRuntime;
  rustCoreWorkerRuntime: Pick<Core['rustCoreWorkerRuntime'],
    'invalidateRustCoreSchedulerCaches' | 'cancelRustCoreSchedulerScopes' |
    'noteRustCoreSchedulerInteractiveActivity' | 'runRustMergedIndexPageQuery' |
    'runRustMergedIndexRebuild' | 'runRustMergedIndexSync' |
    'runRustMergedIndexIdsQuery' | 'runRustMergedIndexMetricsQuery' | 'runRustSharedMetadataOverlayRead'
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
    loadLibraryShellFromSqlite,
    saveMetricsSnapshot,
    readInstallStatusIndex,
  } = options;
  let fontQueryFacadeRuntimeRef: FontQueryFacadeRuntime | null = null;
  let tagFonts: ReturnType<typeof createTagFontQueryRuntime> | undefined;

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

  const { sharedFontMatchesRequest } = createFontMemoryQueryMatcher({
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
    tagFonts?.invalidate();
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
    await openLibraryDb();
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
    ensureMergedIndexReadyForWorker,
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

  const relinkAuthorization = createTagRelinkAuthorizationRuntime(openLibraryDb);

  async function mainProcessFontIndexContains(identity: {
    comparePath: string;
  }): Promise<boolean> {
    return Boolean(await findFontItemInRootIndexes("", identity.comparePath)) || relinkAuthorization.contains(identity.comparePath);
  }

  tagFonts = createTagFontQueryRuntime({
    canReadDetached: relinkAuthorization.canReadDetached,
    findPrevious: path => findFontItemInRootIndexes("", normalizePathForCacheCompare(path), true),
    openLibraryDb, roots: appWatchedFolders,
    readShared: rustCoreWorkerRuntime.runRustSharedMetadataOverlayRead,
    queryLive: (request, limit, offset) => requireFontQueryFacadeRuntime().queryFontPageInLibraryUncached(request, limit, offset),
    hydrate: async items => options.hydrateLocalFavoritesForFonts(await hydrateInstallStatusForFonts(await hydrateLocalTagsForFonts(items))),
    matches: sharedFontMatchesRequest, compare: compareSharedFonts,
  });

  async function queryFontPageInLibraryUncached(
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ): Promise<FontQueryPageResult> {
    const db = await openLibraryDb();
    if (tagQueryScope(request)) return tagFonts!.query(request, limit, offset);
    const result = await requireFontQueryFacadeRuntime().queryFontPageInLibraryUncached(request, limit, offset);
    openTagFontSnapshots(db).remember(result.items.filter(item => item.tagNames?.length || item.localTagNames?.length));
    return { ...result, items: await options.hydrateLocalFavoritesForFonts(await hydrateInstallStatusForFonts(result.items)) };
  }

  async function queryFontsInLibrary(
    requestInput: FontQueryRequest,
  ): Promise<FontQueryResult> {
    await openLibraryDb();
    if (tagQueryScope(requestInput)) {
      const page = await tagFonts!.query(requestInput, Math.max(1, requestInput.limit || FONT_SEARCH_RESULT_LIMIT_DEFAULT), 0);
      return { queryKey: page.queryKey, ids: page.items.map(item => item.id), total: page.total, truncated: page.truncated, engine: page.engine, elapsedMs: page.elapsedMs };
    }
    return requireFontQueryFacadeRuntime().queryFontsInLibrary(requestInput);
  }

  const fontMetricsFallbackRuntime = createFontMetricsRuntime({
    hydrateLocalTagsForFonts,
    appWatchedFolders,
    loadSharedFontsForFolders,
    hydrateInstallStatusForFonts,
    getInstallStatusIndexSnapshot,
    openLibraryDb,
    loadLibraryShellFromSqlite,
    saveMetricsSnapshot,
    inferFontSearchCategory,
    sharedFontMatchesPathPrefixes,
  });

  fontQueryFacadeRuntimeRef = createFontQueryFacadeRuntime({
    ensureMergedIndexReadyForWorker,
    applyPendingActivationState: options.applyPendingActivationState,
    hasPendingActivationState: options.hasPendingActivationState,
    reconcileLocalUserMetrics: async metrics => {
      try {
        const counts = await readLocalUserMetricsFromMergedIndex({
          roots: await appWatchedFolders(), expectedTotal: metrics.total, openMergedIndexDb, openLibraryDb,
          librarySqlitePath, closeSqliteDb, applyPendingActivationState: options.applyPendingActivationState,
        });
        if (counts) return { ...metrics, ...counts };
      } catch (error) { appendStartupLog(`local user metrics snapshot fallback: ${String(error)}`); }
      const fonts = await hydrateInstallStatusForFonts(await loadSharedFontsForFolders(await appWatchedFolders()));
      return { ...metrics, favoriteCount: fonts.filter(font => font.favorite).length, activeCount: fonts.filter(font => font.active).length };
    },
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
    await openLibraryDb();
    return requireFontQueryFacadeRuntime().getFontMetricsFromLibrary();
  }
  return {

    hydrateInstallStatusForFonts,

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
    rememberRelinkedFontFile: relinkAuthorization.rememberRelinkedFontFile,

    queryFontsInLibrary,

    getFontMetricsFromLibrary,

  };
}
