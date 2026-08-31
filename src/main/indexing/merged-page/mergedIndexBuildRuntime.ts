import { rethrowRustCoreDaemonSubmittedWrite } from "../../rust-core/rustCoreDaemonWriteBoundaryRuntime";
import type { MergedIndexSourceInfo } from "../mergedIndexRuntime";
import { rootIndexJsonExpr,type MergedIndexPageRow } from "../rootIndexQuerySql";
import type {
MergedIndexPageContext,
SqliteDb,
} from "./mergedIndexPageTypes";

export function createMergedIndexBuildRuntime(
  ctx: MergedIndexPageContext
) {
  async function rebuildMergedIndexDb(
    db: SqliteDb,
    sources: MergedIndexSourceInfo[],
    sourcesKey: string,
  ): Promise<void> {
    const startedAt = Date.now();
    const now = new Date().toISOString();
    try {
      const rustResult = await ctx.rustCoreWorkerRuntime.runRustMergedIndexRebuild({
        mergedIndexDbPath: ctx.mergedIndexDbPath(),
        schemaVersion: ctx.schemaVersion,
        sourcesKey,
        syncedAt: now,
        sources: sources.map((source) => ({
          root: source.root,
          indexDbPath: source.indexDbPath,
          installDbPath: source.installDbPath,
          indexSignature: source.indexSignature,
          installSignature: source.installSignature,
          sharedMetadataSignature: source.sharedMetadataSignature || 'metadata:none',
        })),
      });
      if (rustResult?.rebuilt) {
        ctx.appendStartupLog(
          `local merged index rebuilt by rust: sources=${sources.length}, rows=${rustResult.rows}, elapsed=${Date.now() - startedAt}ms, workerElapsed=${rustResult.elapsedMs || 0}ms`,
        );
        return;
      }
    } catch (error) {
      rethrowRustCoreDaemonSubmittedWrite(error, ctx.appendStartupLog, "local merged index rust rebuild");
      ctx.appendStartupLog(
        `local merged index rust rebuild fallback to node: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const insertSource = db.prepare(`
      INSERT INTO sources (root_path, index_db_path, install_db_path, index_signature, install_signature, shared_metadata_signature, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEntry = db.prepare(`
      INSERT OR REPLACE INTO entries (
        root_path, relative_path, cache_key, file_size, modified_at, created_at, status, font_json, message, cached_at,
        is_deleted, installed, installed_by, matches_json, category_index, search_text
      ) VALUES (
        @root_path, @relative_path, @cache_key, @file_size, @modified_at, @created_at, @status, @font_json, @message, @cached_at,
        @is_deleted, @installed, @installed_by, @matches_json, @category_index, @search_text
      )
    `);

    let totalRows = 0;
    const collectedSources: Array<{
      source: MergedIndexSourceInfo;
      rows: MergedIndexPageRow[];
    }> = [];
    for (const source of sources) {
      const sourceDb = await ctx.openRootIndexDb(
        source.indexDbPath,
        source.root,
        "root",
        false,
      );
      try {
        const hasInstallJoin = await ctx.attachInstallStatusDbIfAvailable(
          sourceDb,
          source.root,
        );
        const installColumns = hasInstallJoin
          ? ", install_status.installed AS installed, install_status.by_type AS installed_by, install_status.matches_json AS matches_json"
          : ", NULL AS installed, NULL AS installed_by, NULL AS matches_json";
        const joinSql = hasInstallJoin
          ? `LEFT JOIN install_db.install_status AS install_status ON install_status.font_id = ${rootIndexJsonExpr("id")}`
          : "";
        const rawRows = sourceDb
          .prepare(
            `
          SELECT ? AS root_path, entries.relative_path, entries.cache_key, entries.file_size, entries.modified_at, entries.created_at,
                 entries.status, entries.font_json, entries.message, entries.cached_at, COALESCE(entries.is_deleted, 0) AS is_deleted, NULL AS category_index, NULL AS search_text${installColumns}
          FROM entries
          ${joinSql}
          WHERE COALESCE(entries.is_deleted, 0) = 0 AND entries.status = 'ok' AND entries.font_json IS NOT NULL AND json_valid(entries.font_json)
        `,
          )
          .all(source.root) as MergedIndexPageRow[];
        const rows = await ctx.applySharedMetadataToMergedRows(source.root, rawRows);
        collectedSources.push({ source, rows });
        totalRows += rows.length;
      } finally {
        ctx.closeSqliteDb(sourceDb);
      }
    }

    const rebuild = db.transaction(() => {
      db.prepare("DELETE FROM entries").run();
      db.prepare("DELETE FROM sources").run();
      for (const source of sources) {
        insertSource.run(
          source.root,
          source.indexDbPath,
          source.installDbPath || null,
          source.indexSignature,
          source.installSignature,
          source.sharedMetadataSignature || 'metadata:none',
          now,
        );
      }
      for (const item of collectedSources) {
        for (const row of item.rows)
          insertEntry.run(ctx.bindMergedIndexRow(row, item.source.root, now));
      }
      ctx.setSqliteMeta(db, "sourcesKey", sourcesKey);
      ctx.setSqliteMeta(db, "updatedAt", now);
    });
    rebuild();
    ctx.appendStartupLog(
      `local merged index rebuilt: sources=${sources.length}, rows=${totalRows}, elapsed=${Date.now() - startedAt}ms`,
    );
  }

  async function ensureMergedIndexBuilt(
    db: SqliteDb,
    sources: MergedIndexSourceInfo[],
    sourcesKey: string,
  ): Promise<void> {
    const existing = ctx.mergedIndexRebuildInFlight.get(sourcesKey);
    if (existing) {
      ctx.appendStartupLog("local merged index rebuild joined in-flight task");
      await existing;
      return;
    }

    const rebuildPromise = ctx.runMergedIndexMutation(
      `ensure:${sourcesKey.slice(0, 48)}`,
      async ({ commit }) => {
        const currentKey = ctx.getSqliteMeta(db, "sourcesKey");
        if (currentKey === sourcesKey) {
          ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
          return;
        }

        const recheckedSources: MergedIndexSourceInfo[] = [];
        for (const source of sources) {
          recheckedSources.push({
            ...source,
            indexSignature: await ctx.rootIndexContentSignature(
              source.indexDbPath,
              source.root,
            ),
            installSignature: await ctx.installStatusContentSignature(
              source.installDbPath,
            ),
            sharedMetadataSignature:
              await ctx.sharedMetadataSignatureForRoot(source.root),
          });
        }
        const stableSourcesKey = ctx.mergedIndexSourcesKey(recheckedSources);
        const stableCurrentKey = ctx.getSqliteMeta(db, "sourcesKey");
        if (stableCurrentKey !== stableSourcesKey) {
          await rebuildMergedIndexDb(db, recheckedSources, stableSourcesKey);
          commit("ensure-rebuild");
        }
        ctx.mergedIndexReadyProcessKeys.add(stableSourcesKey);
        if (stableSourcesKey !== sourcesKey)
          ctx.mergedIndexReadyProcessKeys.add(sourcesKey);
      },
    );
    ctx.mergedIndexRebuildInFlight.set(sourcesKey, rebuildPromise);
    try {
      await rebuildPromise;
    } finally {
      if (ctx.mergedIndexRebuildInFlight.get(sourcesKey) === rebuildPromise) {
        ctx.mergedIndexRebuildInFlight.delete(sourcesKey);
      }
    }
  }

  return {
    rebuildMergedIndexDb,
    ensureMergedIndexBuilt,
  };
}
