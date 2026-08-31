import { resolve } from "node:path";
import type {
  FontItem,
  FontQueryPageResult,
  FontQueryRequest,
} from "../../../shared/types";
import { fontQueryCacheKey } from "../../library/fontQuerySqlRuntime";
import { nodeIndexedQueryFallbackAllowed } from "../../library/mergedIndexQueryProtocolRuntime";
import { nodeIndexedFallbackDeniedMessage } from "../../library/nodeIndexedFallbackCompatibilityRuntime";
import {
  buildMergedIndexQuerySql,
  sqliteLiteral,
  type MergedIndexPageRow,
} from "../rootIndexQuerySql";
import type {
  MergedIndexBuildRuntime,
  MergedIndexPageContext,
  MergedIndexSourceRuntime,
  SqliteDb,
} from "./mergedIndexPageTypes";
import { requestNeedsValidatedMergedIndex } from "./mergedIndexQueryPredicateRuntime";

export function createMergedIndexPageQueryRuntime(
  ctx: MergedIndexPageContext,
  sourceRuntime: MergedIndexSourceRuntime,
  buildRuntime: MergedIndexBuildRuntime,
  scheduleMergedIndexBackgroundValidation: (
    roots: string[],
    reason: string,
  ) => void,
) {
  async function ensurePendingSnapshotForWorkerQuery(
    roots: string[],
    reason: string,
  ): Promise<void> {
    await ctx.runMergedIndexMutation(
      `pending-snapshot:${ctx.mergedIndexRootsKey(roots)}`,
      async ({ commit }) => {
        const db = await ctx.openMergedIndexDb();
        try {
          if (!ctx.mergedIndexSourcesMatchRoots(db, roots)) {
            ctx.ensureMergedIndexPendingSnapshotForRoots(db, roots);
            commit(`pending-snapshot:${reason}`);
            ctx.appendStartupLog(
              `merged index pending snapshot prepared: roots=${roots.length}, reason=${reason}`,
            );
          }
        } finally {
          ctx.closeSqliteDb(db);
        }
      },
    );
    scheduleMergedIndexBackgroundValidation(roots, reason);
  }

  async function openReadyMergedIndexForRoots(
    roots: string[],
    options: {
      allowLocalSnapshot?: boolean;
      validationReason?: string;
      allowBlockingBuild?: boolean;
    } = {},
  ): Promise<{ db: SqliteDb; mode: "local-snapshot" | "validated" } | null> {
    const db = await ctx.openMergedIndexDb();
    try {
      const allowLocalSnapshot = options.allowLocalSnapshot !== false;
      if (allowLocalSnapshot && ctx.mergedIndexLocalSnapshotUsable(db, roots)) {
        scheduleMergedIndexBackgroundValidation(
          roots,
          options.validationReason || "stale-first-page",
        );
        return { db, mode: "local-snapshot" };
      }

      if (options.allowBlockingBuild === false) {
        ctx.closeSqliteDb(db);
        scheduleMergedIndexBackgroundValidation(
          roots,
          options.validationReason || "non-blocking-query",
        );
        ctx.appendStartupLog(
          `local merged index query skipped blocking ensure: roots=${roots.length}, reason=${options.validationReason || "non-blocking-query"}`,
        );
        return null;
      }

      const sources = await sourceRuntime.mergedIndexSourcesForRoots(roots);
      if (!sources.length) {
        ctx.closeSqliteDb(db);
        return null;
      }
      const sourcesKey = ctx.mergedIndexSourcesKey(sources);
      await buildRuntime.ensureMergedIndexBuilt(db, sources, sourcesKey);
      return { db, mode: "validated" };
    } catch (error) {
      ctx.closeSqliteDb(db);
      throw error;
    }
  }

  async function queryFontPageFromMergedIndexWorker(
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ): Promise<FontQueryPageResult | null> {
    const startedAt = Date.now();
    const folders = await ctx.appWatchedFolders();
    const roots = Array.from(
      new Set((folders || []).filter(Boolean).map((folder) => resolve(folder))),
    );
    if (!roots.length) {
      return {
        queryKey: fontQueryCacheKey({ ...request, limit, offset }),
        items: [],
        total: 0,
        offset,
        limit,
        truncated: false,
        engine: "sql",
        elapsedMs: Date.now() - startedAt,
        tagRevision: ctx.tagRevisionSnapshotForRequest?.(request),
      };
    }

    const needsValidatedSnapshot = requestNeedsValidatedMergedIndex(request);
    if (needsValidatedSnapshot) {
      ctx.appendStartupLog(
        `db worker merged index page query skipped stale snapshot: page=${request.sidebarPage || "library"}, activeFilter=${request.activeFilter?.kind || "all"}, installStatus=${request.installStatus || "all"}`,
      );
      return null;
    }

    scheduleMergedIndexBackgroundValidation(
      roots,
      "worker-page-query-validation",
    );

    const built = buildMergedIndexQuerySql(request, limit, offset);
    if (built.unsupportedReason) {
      ctx.appendStartupLog(
        `db worker merged index page query fallback: ${built.unsupportedReason}`,
      );
      return null;
    }

    const queryPayload = {
      queryKey: fontQueryCacheKey({ ...request, limit, offset }),
      request,
      limit,
      offset,
      roots,
      mergedIndexDbPath: ctx.mergedIndexDbPath(),
      libraryDbPath: ctx.librarySqlitePath(),
      schemaVersion: ctx.schemaVersion,
      tagRevision: ctx.tagRevisionSnapshotForRequest?.(request),
      sql: {
        sql: built.sql,
        countSql: built.countSql,
        params: built.params,
        countParams: built.countParams,
        usedLike: built.usedLike,
      },
    };

    try {
      const rustResult =
        await ctx.rustCoreWorkerRuntime.runRustMergedIndexPageQuery(
          queryPayload,
        );
      if (rustResult) {
        const timings = rustResult.timings || {};
        ctx.appendStartupLog(
          `rust merged index page query: roots=${roots.length}, total=${rustResult.total}, items=${rustResult.items.length}, offset=${offset}, limit=${limit}, page=${request.sidebarPage || "library"}, activeFilter=${request.activeFilter?.kind || "all"}, selectedFolder=${request.selectedFolderId || ""}, installStatus=${request.installStatus || "all"}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${rustResult.elapsedMs}ms, open=${timings.open || 0}ms, count=${timings.count || 0}ms, select=${timings.select || 0}ms, parse=${timings.parse || 0}ms, localTags=${timings.localTags || 0}ms`,
        );
        return rustResult;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/merged index snapshot is not usable/i.test(message)) {
        await ensurePendingSnapshotForWorkerQuery(
          roots,
          "worker-page-query-pending-snapshot",
        );
        try {
          const retryResult =
            await ctx.rustCoreWorkerRuntime.runRustMergedIndexPageQuery(
              queryPayload,
            );
          if (retryResult) {
            const timings = retryResult.timings || {};
            ctx.appendStartupLog(
              `rust merged index page query pending snapshot: roots=${roots.length}, total=${retryResult.total}, items=${retryResult.items.length}, offset=${offset}, limit=${limit}, page=${request.sidebarPage || "library"}, activeFilter=${request.activeFilter?.kind || "all"}, selectedFolder=${request.selectedFolderId || ""}, installStatus=${request.installStatus || "all"}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${retryResult.elapsedMs}ms, open=${timings.open || 0}ms, count=${timings.count || 0}ms, select=${timings.select || 0}ms, parse=${timings.parse || 0}ms, localTags=${timings.localTags || 0}ms`,
            );
            return retryResult;
          }
        } catch (retryError) {
          ctx.appendStartupLog(
            `rust merged index page query pending snapshot retry failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          );
        }
      }
      ctx.appendStartupLog(
        `rust merged index page query fallback to db worker: ${message}`,
      );
    }

    if (!nodeIndexedQueryFallbackAllowed()) {
      ctx.appendStartupLog(
        nodeIndexedFallbackDeniedMessage("db-worker-page", request),
      );
      return null;
    }

    try {
      const result =
        await ctx.dbQueryWorkerRuntime.queryMergedIndexPage(queryPayload);
      const timings = result.timings || {};
      ctx.appendStartupLog(
        `db worker merged index page query: roots=${roots.length}, total=${result.total}, items=${result.items.length}, offset=${offset}, limit=${limit}, page=${request.sidebarPage || "library"}, activeFilter=${request.activeFilter?.kind || "all"}, selectedFolder=${request.selectedFolderId || ""}, installStatus=${request.installStatus || "all"}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${result.elapsedMs}ms, open=${timings.open || 0}ms, count=${timings.count || 0}ms, select=${timings.select || 0}ms, parse=${timings.parse || 0}ms, localTags=${timings.localTags || 0}ms`,
      );
      return result;
    } catch (error) {
      ctx.appendStartupLog(
        `db worker merged index page query fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async function queryFontPageFromMergedIndex(
    request: FontQueryRequest,
    limit: number,
    offset: number,
  ): Promise<FontQueryPageResult | null> {
    const startedAt = Date.now();
    const folders = await ctx.appWatchedFolders();
    const roots = Array.from(
      new Set((folders || []).filter(Boolean).map((folder) => resolve(folder))),
    );
    if (!roots.length) {
      return {
        queryKey: fontQueryCacheKey({ ...request, limit, offset }),
        items: [],
        total: 0,
        offset,
        limit,
        truncated: false,
        engine: "sql",
        elapsedMs: Date.now() - startedAt,
        tagRevision: ctx.tagRevisionSnapshotForRequest?.(request),
      };
    }

    if (!nodeIndexedQueryFallbackAllowed()) {
      ctx.appendStartupLog(
        nodeIndexedFallbackDeniedMessage("local-merged-index", request),
      );
      return null;
    }

    const ensureStartedAt = Date.now();
    const needsValidatedSnapshot = requestNeedsValidatedMergedIndex(request);
    const ready = await openReadyMergedIndexForRoots(roots, {
      allowLocalSnapshot: !needsValidatedSnapshot,
      validationReason: needsValidatedSnapshot
        ? "install-filter-blocking-validation"
        : "first-page-validation",
      allowBlockingBuild: needsValidatedSnapshot,
    });
    const ensureMs = Date.now() - ensureStartedAt;
    if (!ready) return null;
    const { db, mode: ensureMode } = ready;
    try {
      if (!ctx.rootIndexSqliteJsonAvailable(db)) return null;
      if (
        request.sidebarPage === "tags" ||
        request.activeFilter?.kind === "tag"
      ) {
        await ctx.openLibraryDb();
        try {
          db.exec(
            `ATTACH DATABASE ${sqliteLiteral(ctx.librarySqlitePath())} AS local_db`,
          );
        } catch {
          /* already attached or unavailable */
        }
      }
      const buildStartedAt = Date.now();
      const built = buildMergedIndexQuerySql(request, limit, offset);
      const buildMs = Date.now() - buildStartedAt;
      if (built.unsupportedReason) {
        ctx.appendStartupLog(
          `local merged index page query fallback: ${built.unsupportedReason}`,
        );
        return null;
      }
      const countStartedAt = Date.now();
      const totalRow = db.prepare(built.countSql).get(...built.countParams) as
        { count?: number } | undefined;
      const countMs = Date.now() - countStartedAt;
      let total = Number(totalRow?.count || 0);
      const selectStartedAt = Date.now();
      const rows = db
        .prepare(built.sql)
        .all(...built.params) as MergedIndexPageRow[];
      const selectMs = Date.now() - selectStartedAt;
      if (total === 0 && rows.length > 0) total = rows.length;
      const hydrateStartedAt = Date.now();
      const fonts = rows
        .map((row) => ctx.fontFromRootIndexPageRow(row.root_path, row))
        .filter((font): font is FontItem => !!font);
      const parseMs = Date.now() - hydrateStartedAt;
      const localTagStartedAt = Date.now();
      const items = await ctx.hydrateLocalTagsForFonts(fonts);
      const localTagMs = Date.now() - localTagStartedAt;
      ctx.appendStartupLog(
        `local merged index page query: roots=${roots.length}, total=${total}, items=${items.length}, offset=${offset}, limit=${limit}, page=${request.sidebarPage || "library"}, activeFilter=${request.activeFilter?.kind || "all"}, selectedFolder=${request.selectedFolderId || ""}, installStatus=${request.installStatus || "all"}, elapsed=${Date.now() - startedAt}ms, ensure=${ensureMs}ms, ensureMode=${ensureMode}, build=${buildMs}ms, count=${countMs}ms, select=${selectMs}ms, parse=${parseMs}ms, localTags=${localTagMs}ms`,
      );
      return {
        queryKey: fontQueryCacheKey({ ...request, limit, offset }),
        items,
        total,
        offset,
        limit,
        truncated: offset + items.length < total,
        engine: built.usedLike || request.keyword ? "like" : "sql",
        elapsedMs: Date.now() - startedAt,
        tagRevision: ctx.tagRevisionSnapshotForRequest?.(request),
      };
    } finally {
      ctx.closeSqliteDb(db);
    }
  }

  return {
    openReadyMergedIndexForRoots,
    queryFontPageFromMergedIndexWorker,
    queryFontPageFromMergedIndex,
  };
}
