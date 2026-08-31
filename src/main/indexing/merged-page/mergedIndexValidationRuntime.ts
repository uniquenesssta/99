import { resolve } from "node:path";
import type {
MergedIndexBuildRuntime,
MergedIndexPageContext,
MergedIndexSourceRuntime,
} from "./mergedIndexPageTypes";
import {
  checkMergedIndexSharedMetadataExternalChanges,
  isSharedMetadataExternalCheckReason,
  type MergedIndexExternalCheckResult,
} from "./mergedIndexSharedMetadataExternalCheckRuntime";

export function createMergedIndexValidationRuntime(
  ctx: MergedIndexPageContext,
  sourceRuntime: MergedIndexSourceRuntime,
  buildRuntime: MergedIndexBuildRuntime,
) {
  type ExternalCheckResult = MergedIndexExternalCheckResult
  let externalCheckInFlight: Promise<ExternalCheckResult> | null = null
  let lastExternalCheckResult: ExternalCheckResult | null = null
  let lastExternalCheckAt = 0
  const externalCheckReuseMs = 1_500
  function scheduleMergedIndexBackgroundValidation(
    roots: string[],
    reason: string,
  ): void {
    if (!ctx.staleFirstPageEnabled || !roots.length) return;
    const rootsKey = ctx.mergedIndexRootsKey(roots);
    const now = Date.now();
    const last = ctx.mergedIndexLastValidateAt.get(rootsKey) || 0;
    if (
      now - last < ctx.backgroundValidateIntervalMs ||
      ctx.mergedIndexValidateInFlight.has(rootsKey)
    )
      return;
    ctx.mergedIndexLastValidateAt.set(rootsKey, now);
    const task = (async () => {
      const startedAt = Date.now();
      try {
        const sources = await sourceRuntime.mergedIndexSourcesForRoots(roots);
        if (!sources.length) return;
        const sourcesKey = ctx.mergedIndexSourcesKey(sources);
        const db = await ctx.openMergedIndexDb();
        try {
          await buildRuntime.ensureMergedIndexBuilt(db, sources, sourcesKey);
        } finally {
          ctx.closeSqliteDb(db);
        }
        ctx.appendStartupLog(
          `local merged index background validation finished: reason=${reason}, roots=${roots.length}, elapsed=${Date.now() - startedAt}ms`,
        );
      } catch (error) {
        ctx.appendStartupLog(
          `local merged index background validation skipped: reason=${reason}, ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
    ctx.mergedIndexValidateInFlight.set(rootsKey, task);
    task
      .finally(() => {
        ctx.mergedIndexValidateInFlight.delete(rootsKey);
      })
      .catch(() => undefined);
  }

  async function checkMergedIndexExternalChanges(
    reason = "shared-metadata-poll",
  ): Promise<ExternalCheckResult> {
    const now = Date.now();
    if (lastExternalCheckResult && now - lastExternalCheckAt < externalCheckReuseMs) {
      return { ...lastExternalCheckResult, elapsedMs: 0, reason };
    }
    if (externalCheckInFlight) return externalCheckInFlight;

    externalCheckInFlight = (async () => {
      if (isSharedMetadataExternalCheckReason(reason)) {
        const lightweightResult = await checkMergedIndexSharedMetadataExternalChanges({
          ctx,
          sourceRuntime,
          buildRuntime,
          reason,
        });
        if (lightweightResult) return lightweightResult;
      }
      const startedAt = Date.now();
      const roots = Array.from(
        new Set((await ctx.appWatchedFolders()).filter(Boolean).map((folder) => resolve(folder))),
      );
      if (!roots.length) {
        return { changed: false, rebuilt: false, roots: 0, elapsedMs: Date.now() - startedAt, reason };
      }

      const sources = await sourceRuntime.mergedIndexSourcesForRoots(roots);
      if (!sources.length) {
        return { changed: false, rebuilt: false, roots: roots.length, elapsedMs: Date.now() - startedAt, reason };
      }

      const sourcesKey = ctx.mergedIndexSourcesKey(sources);
      const db = await ctx.openMergedIndexDb();
      try {
        const currentKey = ctx.getSqliteMeta(db, "sourcesKey");
        if (currentKey === sourcesKey) {
          return { changed: false, rebuilt: false, roots: roots.length, elapsedMs: Date.now() - startedAt, reason };
        }

        await buildRuntime.ensureMergedIndexBuilt(db, sources, sourcesKey);
        const elapsedMs = Date.now() - startedAt;
        ctx.appendStartupLog(
          `local merged index external sync finished: reason=${reason}, roots=${roots.length}, elapsed=${elapsedMs}ms`,
        );
        return { changed: true, rebuilt: true, roots: roots.length, elapsedMs, reason };
      } catch (error) {
        ctx.appendStartupLog(
          `local merged index external sync failed: reason=${reason}, ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      } finally {
        ctx.closeSqliteDb(db);
      }
    })();

    try {
      const result = await externalCheckInFlight;
      lastExternalCheckResult = result;
      lastExternalCheckAt = Date.now();
      return result;
    } finally {
      externalCheckInFlight = null;
    }
  }

  async function syncMergedIndexAfterInstallStatusRefresh(
    folders: string[],
    syncMergedIndexForRootSnapshot: (rootPath: string, reason: string) => Promise<void>,
  ): Promise<void> {
    const roots = Array.from(
      new Set((folders || []).filter(Boolean).map((folder) => resolve(folder))),
    );
    if (!roots.length) return;
    const startedAt = Date.now();
    for (const root of roots) {
      try {
        await syncMergedIndexForRootSnapshot(root, "install-status-refresh");
      } catch (error) {
        ctx.appendStartupLog(
          `local merged index install status sync skipped: root=${root}, ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await ctx.delayToEventLoop();
    }
    ctx.appendStartupLog(
      `local merged index install status sync finished: roots=${roots.length}, elapsed=${Date.now() - startedAt}ms`,
    );
  }

  return {
    scheduleMergedIndexBackgroundValidation,
    checkMergedIndexExternalChanges,
    syncMergedIndexAfterInstallStatusRefresh,
  };
}
