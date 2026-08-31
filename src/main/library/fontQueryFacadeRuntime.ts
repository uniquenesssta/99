import { resolve } from "node:path";
import type {
FontItem,
FontMetricsResult,
FontQueryPageResult,
FontQueryRequest,
FontQueryResult,
FontSearchResult,
InstallCompareResult,
FontTagRevisionMetadata,
} from "../../shared/types";
import { defaultFontMetricsResult } from "./fontMetricsRuntime";
import { fontQueryCacheKey } from "./fontQuerySqlRuntime";
import { buildMergedIndexIdsQuerySql } from "../indexing/rootIndexQuerySql";
import { shouldUseMergedIndexWorkerForPage } from "./fontQueryWorkerRouteRuntime";
import { createMetricsInstallStatusReconcileCacheRuntime } from "./fontMetricsInstallStatusReconcileRuntime";
import { reconcileMetricsFolderCounts,watchedRootFolderCountTotal } from "./fontMetricsFolderCountReconcileRuntime";
import { createFontMetricsRequestCoalescerRuntime } from "./fontMetricsRequestCoalescerRuntime";
import {
  nodeIndexedQueryFallbackAllowed,
  shouldAcceptIndexedPageProtocol,
  shouldAcceptMetricsProtocol,
  tagRevisionCacheToken,
  tagRevisionMatchesSnapshot,
} from "./mergedIndexQueryProtocolRuntime";
import {
  nodeIndexedFallbackDeniedMessage,
  nodeIndexedFallbackPolicyReason,
  recordNodeIndexedFallbackDisabled,
  recordNodeIndexedFallbackUsed,
} from "./nodeIndexedFallbackCompatibilityRuntime";
import type { TagMetadataRevisionBarrierRuntime } from "./tagMetadataRevisionBarrierRuntime";
import type { MigrationDiagnosticsRuntime } from "../diagnostics/migrationDiagnosticsRuntime";

export type FontQueryFacadeRuntime = {
  searchFontsInLibrary: (
    keywordInput: string,
    limitInput?: number,
  ) => Promise<FontSearchResult>;
  hydrateInstallStatusForFonts: (items: FontItem[]) => Promise<FontItem[]>;
  queryFontPageInLibraryUncached: (
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ) => Promise<FontQueryPageResult>;
  queryFontsInLibrary: (requestInput: FontQueryRequest) => Promise<FontQueryResult>;
  getFontMetricsFromLibrary: () => Promise<FontMetricsResult>;
  clearFontMetricsQueryCache: () => void;
};

export type FontQueryFacadeRuntimeOptions = {
  fontSearchResultLimitDefault: number;
  mergedIndexSchemaVersion: number;
  appendLog: (message: string) => void;
  appWatchedFolders: () => Promise<string[]>;
  cleanSharedFontsForQuery: (request: FontQueryRequest) => Promise<FontItem[]>;
  hydrateLocalTagsForFonts: (items: FontItem[]) => Promise<FontItem[]>;
  readInstallStatusIndex: (
    items: FontItem[],
    options?: { enqueueMissTasks?: boolean },
  ) => Promise<{
    results: Record<string, InstallCompareResult>;
    missingIds?: string[];
  }>;
  queryFontPageFromMergedIndexWorker: (
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ) => Promise<FontQueryPageResult | null>;
  queryFontPageFromMergedIndex: (
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ) => Promise<FontQueryPageResult | null>;
  queryFontPageFromRootIndexes: (
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ) => Promise<FontQueryPageResult | null>;
  scheduleMergedIndexBackgroundValidation: (
    roots: string[],
    reason: string,
  ) => void;
  dbQueryWorkerRuntime: {
    queryMergedIndexMetrics: (args: {
      roots: string[];
      mergedIndexDbPath: string;
      libraryDbPath: string;
      schemaVersion: number;
    }) => Promise<FontMetricsResult & { timings?: Record<string, number>; elapsedMs?: number }>;
  };
  rustCoreWorkerRuntime: {
    runRustMergedIndexIdsQuery: (args: {
      queryKey: string;
      request: FontQueryRequest;
      limit: number;
      roots: string[];
      mergedIndexDbPath: string;
      libraryDbPath: string;
      schemaVersion: number;
      tagRevision?: FontTagRevisionMetadata | Record<string, unknown>;
      sql: {
        sql: string;
        params: unknown[];
        usedLike: boolean;
      };
    }) => Promise<({
      queryKey: string;
      ids: string[];
      total: number;
      limit: number;
      truncated: boolean;
      engine: "like" | "sql";
      elapsedMs?: number;
      timings?: Record<string, number>;
      tagRevision?: unknown;
    }) | null>;
    runRustMergedIndexMetricsQuery: (args: {
      roots: string[];
      mergedIndexDbPath: string;
      libraryDbPath: string;
      schemaVersion: number;
      tagRevision?: FontTagRevisionMetadata | Record<string, unknown>;
    }) => Promise<(FontMetricsResult & { timings?: Record<string, number>; elapsedMs?: number }) | null>;
  };
  mergedIndexDbPath: () => string;
  librarySqlitePath: () => string;
  fontMetricsFallbackRuntime: {
    getFontMetricsFromLibrary: () => Promise<FontMetricsResult>;
  };
  tagMetadataRevisionBarrier?: TagMetadataRevisionBarrierRuntime;
  migrationDiagnostics?: MigrationDiagnosticsRuntime;
};

export function createFontQueryFacadeRuntime(
  options: FontQueryFacadeRuntimeOptions,
): FontQueryFacadeRuntime {
  const metricsReconcileCache = createMetricsInstallStatusReconcileCacheRuntime();
  const metricsRequestCoalescer = createFontMetricsRequestCoalescerRuntime();

  function delay(ms: number): Promise<void> {
    return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
  }

  async function waitForTagIndexedQueryGrace(request: FontQueryRequest, kind: 'page' | 'ids'): Promise<void> {
    const delayMs = options.tagMetadataRevisionBarrier?.indexedQueryDelayMsForRequest(request) || 0;
    if (delayMs <= 0) return;
    options.appendLog(
      `tag metadata barrier delayed indexed ${kind} query: delay=${delayMs}ms, page=${request.sidebarPage || 'library'}, activeFilter=${request.activeFilter?.kind || 'all'}, state=${options.tagMetadataRevisionBarrier?.describe() || ''}`,
    );
    await delay(delayMs);
  }

  function shouldAcceptIndexedPageResult(
    source: string,
    request: FontQueryRequest,
    result: FontQueryPageResult | null,
    snapshot: unknown,
  ): boolean {
    const stale = !!(
      snapshot &&
      options.tagMetadataRevisionBarrier?.resultBecameStaleForRequest(request, snapshot as any)
    );
    const decision = shouldAcceptIndexedPageProtocol({
      request,
      result,
      snapshot,
      stale,
      allowLegacyFallback: nodeIndexedQueryFallbackAllowed(),
    });
    if (!decision.accept && result) {
      options.appendLog(
        `tag-aware indexed page result rejected: source=${source}, reason=${decision.reason || 'unknown'}, page=${request.sidebarPage || 'library'}, activeFilter=${request.activeFilter?.kind || 'all'}, total=${result.total || 0}, engine=${result.engine}`
      );
      options.migrationDiagnostics?.record({
        source,
        kind: 'rejected',
        reason: decision.reason || 'unknown',
        page: request.sidebarPage || 'library',
        activeFilterKind: request.activeFilter?.kind || 'all',
        activeFilterName: request.activeFilter?.name || '',
        total: Number(result.total || 0),
        tagRevisionToken: tagRevisionCacheToken(snapshot),
      });
    } else if (decision.accept && result) {
      options.migrationDiagnostics?.record({
        source,
        kind: 'accepted',
        reason: decision.reason || 'protocol-ok',
        page: request.sidebarPage || 'library',
        activeFilterKind: request.activeFilter?.kind || 'all',
        activeFilterName: request.activeFilter?.name || '',
        total: Number(result.total || 0),
        tagRevisionToken: tagRevisionCacheToken(snapshot),
      });
    }
    return decision.accept;
  }
  async function searchFontsInLibrary(
    keywordInput: string,
    limitInput?: number,
  ): Promise<FontSearchResult> {
    const startedAt = Date.now();
    const keyword = String(keywordInput || "").trim();
    const limit = Math.max(
      1,
      Math.min(
        500000,
        Number(limitInput || options.fontSearchResultLimitDefault) ||
          options.fontSearchResultLimitDefault,
      ),
    );
    const request: FontQueryRequest = { keyword, limit, offset: 0 };
    const rustIds = await queryFontIdsWithRust(request, limit, startedAt, "search");
    if (rustIds) {
      return {
        keyword,
        ids: rustIds.ids,
        total: rustIds.total,
        truncated: rustIds.truncated,
        engine: rustIds.engine === "like" ? "like" : keyword ? "like" : "none",
        elapsedMs: Date.now() - startedAt,
      };
    }
    const items = await options.cleanSharedFontsForQuery(request);
    const ids = items.slice(0, limit).map((font) => font.id);
    return {
      keyword,
      ids,
      total: ids.length,
      truncated: items.length > limit,
      engine: keyword ? "like" : "none",
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function hydrateInstallStatusForFonts(
    items: FontItem[],
  ): Promise<FontItem[]> {
    if (!items.length) return items;
    try {
      const { results } = await options.readInstallStatusIndex(items, {
        enqueueMissTasks: false,
      });
      if (!Object.keys(results).length)
        return items.map((item) => ({ ...item, installStatusKnown: false }));
      return items.map((item) => {
        const result = results[item.id];
        return result
          ? {
              ...item,
              installStatusKnown: true,
              systemInstalled: result.installed && result.by !== "managed",
              systemInstallMatches: result.matches || [],
              active:
                item.active || result.by === "managed" || result.by === "both",
            }
          : { ...item, installStatusKnown: false };
      });
    } catch (error) {
      options.appendLog(
        `hydrateInstallStatusForFonts failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return items.map((item) => ({ ...item, installStatusKnown: false }));
    }
  }

  async function queryFontPageInLibraryUncached(
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ): Promise<FontQueryPageResult> {
    const startedAt = Date.now();
    await waitForTagIndexedQueryGrace(request, 'page');
    let tagBarrierSnapshot = options.tagMetadataRevisionBarrier?.snapshotForRequest(request);
    const allowNodeIndexedFallback = nodeIndexedQueryFallbackAllowed();

    let workerMergedPage = shouldUseMergedIndexWorkerForPage(request)
      ? await options
          .queryFontPageFromMergedIndexWorker(request, limit, offset)
          .catch((error) => {
            options.appendLog(
              `db worker merged index page query failed, fallback to main merged index: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          })
      : null;
    if (shouldAcceptIndexedPageResult('rust-worker', request, workerMergedPage, tagBarrierSnapshot)) return workerMergedPage as FontQueryPageResult;
    if (workerMergedPage && options.tagMetadataRevisionBarrier?.resultBecameStaleForRequest(request, tagBarrierSnapshot as any)) {
      await waitForTagIndexedQueryGrace(request, 'page');
      tagBarrierSnapshot = options.tagMetadataRevisionBarrier?.snapshotForRequest(request);
      workerMergedPage = shouldUseMergedIndexWorkerForPage(request)
        ? await options.queryFontPageFromMergedIndexWorker(request, limit, offset).catch((error) => {
            options.appendLog(
              `db worker merged index page retry failed, fallback to main merged index: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          })
        : null;
      if (shouldAcceptIndexedPageResult('rust-worker-retry', request, workerMergedPage, tagBarrierSnapshot)) return workerMergedPage as FontQueryPageResult;
    }

    const mergedPage = !allowNodeIndexedFallback ? null : await options
      .queryFontPageFromMergedIndex(request, limit, offset)
      .catch((error) => {
        options.appendLog(
          `local merged index page query failed, fallback to root indexes: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
    if (!allowNodeIndexedFallback) {
      options.appendLog(nodeIndexedFallbackDeniedMessage('local-merged-index', request));
      options.appendLog(nodeIndexedFallbackDeniedMessage('root-index', request));
      recordNodeIndexedFallbackDisabled({
        diagnostics: options.migrationDiagnostics,
        source: 'local-merged-index',
        request,
        tagRevisionToken: tagRevisionCacheToken(tagBarrierSnapshot),
      });
      recordNodeIndexedFallbackDisabled({
        diagnostics: options.migrationDiagnostics,
        source: 'root-index',
        request,
        tagRevisionToken: tagRevisionCacheToken(tagBarrierSnapshot),
      });
    }
    if (shouldAcceptIndexedPageResult('local-merged-index', request, mergedPage, tagBarrierSnapshot)) return mergedPage as FontQueryPageResult;

    const sqlPage = !allowNodeIndexedFallback ? null : await options
      .queryFontPageFromRootIndexes(request, limit, offset)
      .catch((error) => {
        options.appendLog(
          `root index page query failed, fallback to memory filter: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      });
    if (shouldAcceptIndexedPageResult('root-index', request, sqlPage, tagBarrierSnapshot)) return sqlPage as FontQueryPageResult;

    const items = await options.cleanSharedFontsForQuery(request);
    const pageItems = await options.hydrateLocalTagsForFonts(
      items.slice(offset, offset + limit),
    );
    const memoryElapsedMs = Date.now() - startedAt;
    options.appendLog(
      `memory fallback page query: total=${items.length}, items=${pageItems.length}, offset=${offset}, limit=${limit}, elapsed=${memoryElapsedMs}ms`,
    );
    options.migrationDiagnostics?.record({
      source: 'memory-query',
      kind: 'fresh-memory',
      reason: 'indexed-unavailable',
      page: request.sidebarPage || 'library',
      activeFilterKind: request.activeFilter?.kind || 'all',
      activeFilterName: request.activeFilter?.name || '',
      total: items.length,
      elapsedMs: memoryElapsedMs,
      tagRevisionToken: tagRevisionCacheToken(tagBarrierSnapshot),
    });
    return {
      queryKey: fontQueryCacheKey({ ...request, limit, offset }),
      items: pageItems,
      total: items.length,
      offset,
      limit,
      truncated: offset + pageItems.length < items.length,
      engine: request.keyword ? "like" : "sql",
      elapsedMs: Date.now() - startedAt,
      tagRevision: tagBarrierSnapshot as any,
    };
  }


  async function queryFontIdsWithRust(
    request: FontQueryRequest,
    limit: number,
    startedAt: number,
    reason: string,
  ): Promise<{ ids: string[]; total: number; truncated: boolean; engine: "like" | "sql" } | null> {
    try {
      const folders = await options.appWatchedFolders();
      const roots = Array.from(
        new Set((folders || []).filter(Boolean).map((folder) => resolve(folder))),
      );
      if (!roots.length) {
        return { ids: [], total: 0, truncated: false, engine: request.keyword ? "like" : "sql" };
      }
      options.scheduleMergedIndexBackgroundValidation(
        roots,
        `rust-ids-${reason}-validation`,
      );
      const built = buildMergedIndexIdsQuerySql(request, limit + 1);
      if (built.unsupportedReason) {
        options.appendLog(`rust ids query fallback: ${built.unsupportedReason}`);
        return null;
      }
      const tagRevisionSnapshot = options.tagMetadataRevisionBarrier?.snapshotForRequest(request);
      const rustResult = await options.rustCoreWorkerRuntime.runRustMergedIndexIdsQuery({
        queryKey: fontQueryCacheKey({ ...request, limit }),
        request,
        limit,
        roots,
        mergedIndexDbPath: options.mergedIndexDbPath(),
        libraryDbPath: options.librarySqlitePath(),
        schemaVersion: options.mergedIndexSchemaVersion,
        tagRevision: tagRevisionSnapshot,
        sql: {
          sql: built.sql,
          params: built.params,
          usedLike: built.usedLike,
        },
      });
      if (!rustResult) return null;
      if (tagRevisionCacheToken(tagRevisionSnapshot) && !tagRevisionMatchesSnapshot(tagRevisionSnapshot, rustResult.tagRevision as any)) {
        options.appendLog(`rust ids query rejected: reason=missing-or-mismatched-tag-revision, reasonKind=${reason}`);
        options.migrationDiagnostics?.record({
          source: 'rust-ids',
          kind: 'rejected',
          reason: 'missing-or-mismatched-tag-revision',
          page: request.sidebarPage || 'library',
          activeFilterKind: request.activeFilter?.kind || 'all',
          activeFilterName: request.activeFilter?.name || '',
          total: Number(rustResult.total || 0),
          tagRevisionToken: tagRevisionCacheToken(tagRevisionSnapshot),
        });
        return null;
      }
      const timings = rustResult.timings || {};
      const idsElapsedMs = Date.now() - startedAt;
      options.appendLog(
        `rust ids query: reason=${reason}, ids=${rustResult.ids.length}, truncated=${rustResult.truncated}, limit=${limit}, elapsed=${idsElapsedMs}ms, workerElapsed=${rustResult.elapsedMs || 0}ms, select=${timings.select || 0}ms`,
      );
      options.migrationDiagnostics?.record({
        source: 'rust-ids',
        kind: 'accepted',
        reason,
        page: request.sidebarPage || 'library',
        activeFilterKind: request.activeFilter?.kind || 'all',
        activeFilterName: request.activeFilter?.name || '',
        total: Number(rustResult.total || 0),
        elapsedMs: idsElapsedMs,
        tagRevisionToken: tagRevisionCacheToken(tagRevisionSnapshot),
      });
      return {
        ids: rustResult.ids,
        total: rustResult.total,
        truncated: rustResult.truncated,
        engine: rustResult.engine,
      };
    } catch (error) {
      options.appendLog(
        `rust ids query fallback to memory: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async function queryFontsInLibrary(
    requestInput: FontQueryRequest,
  ): Promise<FontQueryResult> {
    const startedAt = Date.now();
    const request = requestInput || {};
    const queryKey = fontQueryCacheKey(request);
    const limit = Math.max(
      1,
      Math.min(
        500000,
        Number(request.limit || options.fontSearchResultLimitDefault) ||
          options.fontSearchResultLimitDefault,
      ),
    );
    await waitForTagIndexedQueryGrace(request, 'ids');
    const rustIds = await queryFontIdsWithRust(request, limit, startedAt, "query");
    if (rustIds) {
      return {
        queryKey,
        ids: rustIds.ids,
        total: rustIds.total,
        truncated: rustIds.truncated,
        engine: rustIds.engine,
        elapsedMs: Date.now() - startedAt,
      };
    }
    const items = await options.cleanSharedFontsForQuery({ ...request, limit });
    const ids = items.slice(0, limit).map((font) => font.id);
    return {
      queryKey,
      ids,
      total: ids.length,
      truncated: items.length > limit,
      engine: request.keyword ? "like" : "sql",
      elapsedMs: Date.now() - startedAt,
    };
  }

  async function loadFontMetricsFromLibraryUncoalesced(): Promise<FontMetricsResult> {
    const startedAt = Date.now();
    try {
      const folders = await options.appWatchedFolders();
      const roots = Array.from(
        new Set((folders || []).filter(Boolean).map((folder) => resolve(folder))),
      );
      if (!roots.length) return defaultFontMetricsResult();
      const queryPayload = {
        roots,
        mergedIndexDbPath: options.mergedIndexDbPath(),
        libraryDbPath: options.librarySqlitePath(),
        schemaVersion: options.mergedIndexSchemaVersion,
        tagRevision: options.tagMetadataRevisionBarrier?.snapshot(),
      };

      try {
        const rustResult = await options.rustCoreWorkerRuntime.runRustMergedIndexMetricsQuery(queryPayload);
        if (rustResult) {
          const metricsDecision = shouldAcceptMetricsProtocol({
            result: rustResult,
            snapshot: queryPayload.tagRevision,
            allowLegacyFallback: nodeIndexedQueryFallbackAllowed(),
          });
          if (!metricsDecision.accept) {
            options.appendLog(`rust metrics query rejected: reason=${metricsDecision.reason || 'unknown'}`);
            options.migrationDiagnostics?.record({
              source: 'rust-metrics',
              kind: 'rejected',
              reason: metricsDecision.reason || 'unknown',
              total: Number(rustResult.total || 0),
              tagRevisionToken: tagRevisionCacheToken(queryPayload.tagRevision),
            });
          } else {
          const timings = rustResult.timings || {};
          const metricsElapsedMs = Date.now() - startedAt;
          let fallbackMetricsTask: Promise<FontMetricsResult | null> | null = null;
          const loadFallbackMetrics = (): Promise<FontMetricsResult | null> => {
            if (!fallbackMetricsTask) {
              fallbackMetricsTask = options.fontMetricsFallbackRuntime.getFontMetricsFromLibrary().catch((error) => {
                options.appendLog(
                  `rust metrics fallback snapshot skipped: ${error instanceof Error ? error.message : String(error)}`,
                );
                return null;
              });
            }
            return fallbackMetricsTask;
          };
          const reconciledFolderMetrics = await reconcileMetricsFolderCounts({
            primary: rustResult,
            roots,
            source: 'rust-merged-index',
            appendLog: options.appendLog,
            loadFallback: loadFallbackMetrics,
          });
          options.appendLog(
            `rust metrics query: total=${reconciledFolderMetrics.total}, installed=${reconciledFolderMetrics.installedCount}, notInstalled=${reconciledFolderMetrics.notInstalledCount}, missing=${reconciledFolderMetrics.installStatusMissingCount || 0}, folders=${Object.keys(reconciledFolderMetrics.folderCounts || {}).length}, rootFolderTotal=${watchedRootFolderCountTotal(reconciledFolderMetrics, roots)}, elapsed=${metricsElapsedMs}ms, workerElapsed=${reconciledFolderMetrics.elapsedMs}ms, select=${timings.select || 0}ms, parse=${timings.parse || 0}ms`,
          );
          options.migrationDiagnostics?.record({
            source: 'rust-metrics',
            kind: 'accepted',
            reason: metricsDecision.reason || 'protocol-ok',
            total: Number(reconciledFolderMetrics.total || 0),
            elapsedMs: metricsElapsedMs,
            tagRevisionToken: tagRevisionCacheToken(queryPayload.tagRevision),
          });
          if ((reconciledFolderMetrics.installStatusMissingCount || 0) > 0) {
            return metricsReconcileCache.reconcileWithFallback({
              primary: reconciledFolderMetrics,
              source: "rust-merged-index",
              appendLog: options.appendLog,
              loadFallback: loadFallbackMetrics,
            });
          }
          return reconciledFolderMetrics;
          }
        }
      } catch (error) {
        options.appendLog(
          `rust metrics query fallback to db worker: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!nodeIndexedQueryFallbackAllowed()) {
        options.appendLog(nodeIndexedFallbackDeniedMessage('db-worker-metrics'));
        recordNodeIndexedFallbackDisabled({
          diagnostics: options.migrationDiagnostics,
          source: 'db-worker-metrics',
          tagRevisionToken: tagRevisionCacheToken(queryPayload.tagRevision),
        });
        return options.fontMetricsFallbackRuntime.getFontMetricsFromLibrary();
      }

      const result = await options.dbQueryWorkerRuntime.queryMergedIndexMetrics(queryPayload);
      let fallbackMetricsTask: Promise<FontMetricsResult | null> | null = null;
      const loadFallbackMetrics = (): Promise<FontMetricsResult | null> => {
        if (!fallbackMetricsTask) {
          fallbackMetricsTask = options.fontMetricsFallbackRuntime.getFontMetricsFromLibrary().catch((error) => {
            options.appendLog(
              `db worker metrics fallback snapshot skipped: ${error instanceof Error ? error.message : String(error)}`,
            );
            return null;
          });
        }
        return fallbackMetricsTask;
      };
      const reconciledFolderMetrics = await reconcileMetricsFolderCounts({
        primary: result,
        roots,
        source: 'db-worker-merged-index',
        appendLog: options.appendLog,
        loadFallback: loadFallbackMetrics,
      });
      recordNodeIndexedFallbackUsed({
        diagnostics: options.migrationDiagnostics,
        source: 'db-worker-metrics',
        reason: nodeIndexedFallbackPolicyReason(),
        total: Number(reconciledFolderMetrics.total || 0),
        tagRevisionToken: tagRevisionCacheToken(queryPayload.tagRevision),
      });
      const timings = result.timings || {};
      options.appendLog(
        `db worker metrics query: total=${reconciledFolderMetrics.total}, installed=${reconciledFolderMetrics.installedCount}, notInstalled=${reconciledFolderMetrics.notInstalledCount}, missing=${reconciledFolderMetrics.installStatusMissingCount || 0}, folders=${Object.keys(reconciledFolderMetrics.folderCounts || {}).length}, rootFolderTotal=${watchedRootFolderCountTotal(reconciledFolderMetrics, roots)}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${reconciledFolderMetrics.elapsedMs}ms, select=${timings.select || 0}ms, parse=${timings.parse || 0}ms`,
      );
      if ((reconciledFolderMetrics.installStatusMissingCount || 0) > 0) {
        return metricsReconcileCache.reconcileWithFallback({
          primary: reconciledFolderMetrics,
          source: "db-worker-merged-index",
          appendLog: options.appendLog,
          loadFallback: loadFallbackMetrics,
        });
      }
      return reconciledFolderMetrics;
    } catch (error) {
      options.appendLog(
        `db worker metrics query fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return options.fontMetricsFallbackRuntime.getFontMetricsFromLibrary();
    }
  }
  async function getFontMetricsFromLibrary(): Promise<FontMetricsResult> {
    if (options.tagMetadataRevisionBarrier?.shouldBypassFastMetrics()) {
      metricsRequestCoalescer.clear();
      options.appendLog(`tag metadata barrier cleared fast metrics cache: state=${options.tagMetadataRevisionBarrier.describe()}`);
      options.migrationDiagnostics?.record({
        source: 'font-query-cache',
        kind: 'cache-clear',
        reason: 'tag-metadata-barrier-fast-metrics',
        tagRevisionToken: tagRevisionCacheToken(options.tagMetadataRevisionBarrier?.snapshot()),
      });
    }
    const metricsRevisionToken = tagRevisionCacheToken(options.tagMetadataRevisionBarrier?.snapshot());
    return metricsRequestCoalescer.run({
      appendLog: options.appendLog,
      load: loadFontMetricsFromLibraryUncoalesced,
      key: metricsRevisionToken ? `metrics:${metricsRevisionToken}` : 'metrics:default',
    });
  }


  function clearFontMetricsQueryCache(): void {
    metricsRequestCoalescer.clear();
  }

  return {
    searchFontsInLibrary,
    hydrateInstallStatusForFonts,
    queryFontPageInLibraryUncached,
    queryFontsInLibrary,
    getFontMetricsFromLibrary,
    clearFontMetricsQueryCache,
  };
}
