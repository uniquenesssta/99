import type { FontIndexChangePayload } from "../../../shared/types";
import { rethrowRustCoreDaemonSubmittedWrite } from "../../rust-core/rustCoreDaemonWriteBoundaryRuntime";
import {
  isInstallStatusIncrementalSyncReason,
  isRootIndexIncrementalSyncReason,
  isSharedMetadataIncrementalSyncReason,
  sourceKeyChangedOnlyByInstallStatus,
  sourceKeyChangedOnlyByRootIndex,
  sourceKeyChangedOnlyBySharedMetadata,
} from "./mergedIndexSourceChangeRuntime";
import type {
  MergedIndexBuildRuntime,
  MergedIndexPageContext,
  MergedIndexSourceRuntime,
} from "./mergedIndexPageTypes";

export function createMergedIndexSyncRuntime(
  ctx: MergedIndexPageContext,
  sourceRuntime: MergedIndexSourceRuntime,
  buildRuntime: MergedIndexBuildRuntime,
) {
  async function syncMergedIndexForRootIncremental(
    rootPath: string,
    payload: FontIndexChangePayload,
    reason: string,
  ): Promise<void> {
    return ctx.runMergedIndexMutation(
      `incremental:${ctx.normalizePathForCacheCompare(rootPath)}:${reason}`,
      async ({ commit }) => {
        const startedAt = Date.now();
        const roots = await ctx.appWatchedFolders();
        const sources = await sourceRuntime.mergedIndexSourcesForRoots(roots);
        const source = sources.find(
          (item) =>
            ctx.normalizePathForCacheCompare(item.root) ===
            ctx.normalizePathForCacheCompare(rootPath),
        );
        if (!source || !sources.length) return;

        const relativePaths = sourceRuntime.relativePathsFromFontIndexPayload(
          source.root,
          payload,
        );
        if (!relativePaths.length) {
          ctx.appendStartupLog(
            `local merged index incremental sync skipped: reason=${reason}, root=${source.root}, no changes`,
          );
          return;
        }

        const sourcesKey = ctx.mergedIndexSourcesKey(sources);
        const db = await ctx.openMergedIndexDb();
        try {
          const currentSourcesKey = ctx.getSqliteMeta(db, "sourcesKey");
          const rootsChanged = !ctx.mergedIndexSourcesMatchRoots(db, roots);
          const sourcesChanged = currentSourcesKey !== sourcesKey;
          const metadataOnlySourceChange =
            sourcesChanged &&
            isSharedMetadataIncrementalSyncReason(reason) &&
            sourceKeyChangedOnlyBySharedMetadata(currentSourcesKey, sourcesKey);
          const rootIndexOnlySourceChange =
            sourcesChanged &&
            isRootIndexIncrementalSyncReason(reason) &&
            sourceKeyChangedOnlyByRootIndex(currentSourcesKey, sourcesKey);
          if (
            rootsChanged ||
            (sourcesChanged &&
              !metadataOnlySourceChange &&
              !rootIndexOnlySourceChange)
          ) {
            await buildRuntime.rebuildMergedIndexDb(db, sources, sourcesKey);
            commit(`incremental-rebuild:${reason}`);
            ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
            ctx.appendStartupLog(
              `local merged index incremental sync fell back to rebuild: reason=${reason}, rootsChanged=${rootsChanged}, sourcesChanged=${sourcesChanged}, elapsed=${Date.now() - startedAt}ms`,
            );
            return;
          }
          if (metadataOnlySourceChange) {
            ctx.appendStartupLog(
              `local merged index incremental sync accepted shared metadata source change: reason=${reason}, root=${source.root}`,
            );
          } else if (rootIndexOnlySourceChange) {
            ctx.appendStartupLog(
              `local merged index incremental sync accepted root index source change: reason=${reason}, root=${source.root}`,
            );
          }

          const now = new Date().toISOString();
          try {
            const rustResult =
              await ctx.rustCoreWorkerRuntime.runRustMergedIndexSync({
                mergedIndexDbPath: ctx.mergedIndexDbPath(),
                schemaVersion: ctx.schemaVersion,
                sourcesKey,
                syncedAt: now,
                source: {
                  root: source.root,
                  indexDbPath: source.indexDbPath,
                  installDbPath: source.installDbPath,
                  indexSignature: source.indexSignature,
                  installSignature: source.installSignature,
                  sharedMetadataSignature:
                    source.sharedMetadataSignature || "metadata:none",
                },
                relativePaths,
                fullSnapshot: false,
                reason,
              });
            if (rustResult?.synced) {
              commit(`incremental-rust:${reason}`);
              ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
              ctx.appendStartupLog(
                `local merged index incrementally synced by rust: reason=${reason}, root=${source.root}, changed=${relativePaths.length}, rows=${rustResult.rows}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${rustResult.elapsedMs || 0}ms`,
              );
              return;
            }
          } catch (error) {
            rethrowRustCoreDaemonSubmittedWrite(
              error,
              ctx.appendStartupLog,
              "local merged index rust incremental sync",
            );
            ctx.appendStartupLog(
              `local merged index rust incremental sync fallback to node: reason=${reason}, root=${source.root}, ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          const rows = await sourceRuntime.readMergedRowsForSource(
            source,
            relativePaths,
          );
          const deleteEntry = db.prepare(
            "DELETE FROM entries WHERE root_path = ? AND relative_path = ?",
          );
          const insertEntry = ctx.mergedIndexInsertStatement(db);
          const sync = db.transaction(() => {
            for (const relativePath of relativePaths)
              deleteEntry.run(source.root, relativePath);
            for (const row of rows)
              insertEntry.run(ctx.bindMergedIndexRow(row, source.root, now));
            ctx.writeMergedIndexSourceRow(db, source, now);
            ctx.setSqliteMeta(db, "sourcesKey", sourcesKey);
            ctx.setSqliteMeta(db, "updatedAt", now);
            ctx.setSqliteMeta(db, "lastIncrementalSyncReason", reason);
          });
          sync();
          commit(`incremental-node:${reason}`);
          ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
          ctx.appendStartupLog(
            `local merged index incrementally synced: reason=${reason}, root=${source.root}, changed=${relativePaths.length}, rows=${rows.length}, elapsed=${Date.now() - startedAt}ms`,
          );
        } catch (error) {
          rethrowRustCoreDaemonSubmittedWrite(
            error,
            ctx.appendStartupLog,
            "local merged index incremental sync",
          );
          ctx.appendStartupLog(
            `local merged index incremental sync failed: reason=${reason}, root=${source.root}, ${error instanceof Error ? error.message : String(error)}`,
          );
          await buildRuntime.rebuildMergedIndexDb(db, sources, sourcesKey);
          commit(`incremental-recovery-rebuild:${reason}`);
          ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
        } finally {
          ctx.closeSqliteDb(db);
        }
      },
    );
  }

  async function syncMergedIndexForRootSnapshot(
    rootPath: string,
    reason: string,
  ): Promise<void> {
    return ctx.runMergedIndexMutation(
      `snapshot:${ctx.normalizePathForCacheCompare(rootPath)}:${reason}`,
      async ({ commit }) => {
        const startedAt = Date.now();
        const roots = await ctx.appWatchedFolders();
        const sources = await sourceRuntime.mergedIndexSourcesForRoots(roots);
        const source = sources.find(
          (item) =>
            ctx.normalizePathForCacheCompare(item.root) ===
            ctx.normalizePathForCacheCompare(rootPath),
        );
        if (!source || !sources.length) return;

        const sourcesKey = ctx.mergedIndexSourcesKey(sources);
        const db = await ctx.openMergedIndexDb();
        try {
          const currentSourcesKey = ctx.getSqliteMeta(db, "sourcesKey");
          const rootsChanged = !ctx.mergedIndexSourcesMatchRoots(db, roots);
          const sourcesChanged = currentSourcesKey !== sourcesKey;
          const installStatusOnlySourceChange =
            sourcesChanged &&
            isInstallStatusIncrementalSyncReason(reason) &&
            sourceKeyChangedOnlyByInstallStatus(currentSourcesKey, sourcesKey);
          if (
            rootsChanged ||
            (sourcesChanged && !installStatusOnlySourceChange)
          ) {
            await buildRuntime.rebuildMergedIndexDb(db, sources, sourcesKey);
            commit(`snapshot-rebuild:${reason}`);
            ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
            ctx.appendStartupLog(
              `local merged index root snapshot sync fell back to rebuild: reason=${reason}, rootsChanged=${rootsChanged}, sourcesChanged=${sourcesChanged}, elapsed=${Date.now() - startedAt}ms`,
            );
            return;
          }
          if (installStatusOnlySourceChange) {
            ctx.appendStartupLog(
              `local merged index root snapshot sync accepted install status source change: reason=${reason}, root=${source.root}`,
            );
          }

          const now = new Date().toISOString();
          try {
            const rustResult =
              await ctx.rustCoreWorkerRuntime.runRustMergedIndexSync({
                mergedIndexDbPath: ctx.mergedIndexDbPath(),
                schemaVersion: ctx.schemaVersion,
                sourcesKey,
                syncedAt: now,
                source: {
                  root: source.root,
                  indexDbPath: source.indexDbPath,
                  installDbPath: source.installDbPath,
                  indexSignature: source.indexSignature,
                  installSignature: source.installSignature,
                  sharedMetadataSignature:
                    source.sharedMetadataSignature || "metadata:none",
                },
                fullSnapshot: true,
                reason,
              });
            if (rustResult?.synced) {
              commit(`snapshot-rust:${reason}`);
              ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
              ctx.appendStartupLog(
                `local merged index root snapshot synced by rust: reason=${reason}, root=${source.root}, rows=${rustResult.rows}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${rustResult.elapsedMs || 0}ms`,
              );
              return;
            }
          } catch (error) {
            rethrowRustCoreDaemonSubmittedWrite(
              error,
              ctx.appendStartupLog,
              "local merged index rust root snapshot sync",
            );
            ctx.appendStartupLog(
              `local merged index rust root snapshot sync fallback to node: reason=${reason}, root=${source.root}, ${error instanceof Error ? error.message : String(error)}`,
            );
          }

          const rows = await sourceRuntime.readMergedRowsForSource(source);
          const insertEntry = ctx.mergedIndexInsertStatement(db);
          const sync = db.transaction(() => {
            db.prepare("DELETE FROM entries WHERE root_path = ?").run(
              source.root,
            );
            for (const row of rows)
              insertEntry.run(ctx.bindMergedIndexRow(row, source.root, now));
            ctx.writeMergedIndexSourceRow(db, source, now);
            ctx.setSqliteMeta(db, "sourcesKey", sourcesKey);
            ctx.setSqliteMeta(db, "updatedAt", now);
            ctx.setSqliteMeta(db, "lastRootSnapshotSyncReason", reason);
          });
          sync();
          commit(`snapshot-node:${reason}`);
          ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
          ctx.appendStartupLog(
            `local merged index root snapshot synced: reason=${reason}, root=${source.root}, rows=${rows.length}, elapsed=${Date.now() - startedAt}ms`,
          );
        } catch (error) {
          rethrowRustCoreDaemonSubmittedWrite(
            error,
            ctx.appendStartupLog,
            "local merged index root snapshot sync",
          );
          ctx.appendStartupLog(
            `local merged index root snapshot sync failed: reason=${reason}, root=${source.root}, ${error instanceof Error ? error.message : String(error)}`,
          );
          await buildRuntime.rebuildMergedIndexDb(db, sources, sourcesKey);
          commit(`snapshot-recovery-rebuild:${reason}`);
          ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
        } finally {
          ctx.closeSqliteDb(db);
        }
      },
    );
  }

  return {
    syncMergedIndexForRootIncremental,
    syncMergedIndexForRootSnapshot,
  };
}
