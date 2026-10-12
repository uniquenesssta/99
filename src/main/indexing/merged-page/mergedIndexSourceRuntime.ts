import { rootIndexInstallJoinExpr } from '../root-query/rootIndexQuerySharedSql'
import { resolve } from "node:path";
import type { FontIndexChangePayload } from "../../../shared/types";
import type { MergedIndexSourceInfo } from "../mergedIndexRuntime";
import { type MergedIndexPageRow } from "../rootIndexQuerySql";
import type { MergedIndexPageContext } from "./mergedIndexPageTypes";

export function readMergedIndexAppliedSources(ctx: MergedIndexPageContext, db: any): MergedIndexSourceInfo[] {
  if (ctx.getSqliteMeta(db, 'schemaVersion') !== String(ctx.schemaVersion)
    || !ctx.sqliteTableExists(db, 'sources') || !ctx.sqliteTableExists(db, 'entries')) {
    throw new Error('merged-projection-schema-unavailable')
  }
  const rows = db.prepare('SELECT * FROM sources ORDER BY root_path').all() as Array<Record<string, unknown>>
  const sources = rows.map(row => ({
    root: String(row.root_path || ''), indexDbPath: String(row.index_db_path || ''),
    installDbPath: row.install_db_path ? String(row.install_db_path) : undefined,
    indexSignature: String(row.index_signature || ''), installSignature: String(row.install_signature || ''),
    sharedMetadataSignature: String(row.shared_metadata_signature || ''),
  }))
  const roots = new Set(sources.map(source => ctx.normalizePathForCacheCompare(source.root)))
  if (roots.size !== sources.length || sources.some(source => !source.root || !source.indexSignature
    || !source.installSignature || !source.sharedMetadataSignature)) throw new Error('merged-projection-receipt-invalid')
  const key = ctx.getSqliteMeta(db, 'sourcesKey')
  const pendingKey = `pending:${ctx.mergedIndexRootsKey(sources.map(source => source.root))}`
  if (key !== ctx.mergedIndexSourcesKey(sources) && key !== pendingKey && (sources.length || key)) {
    throw new Error('merged-projection-receipt-mismatch')
  }
  return sources
}

export function assertFreshMergedIndexSource(source: MergedIndexSourceInfo): void {
  if (!source.indexDbPath || !source.indexSignature || /^(missing|stat:|pending)/.test(source.indexSignature)
    || !source.installSignature || /^(missing-table|stat:|pending)/.test(source.installSignature)
    || !source.sharedMetadataSignature || /^metadata:(error|stat:|pending)/.test(source.sharedMetadataSignature)) {
    throw new Error('merged-source-receipt-unavailable')
  }
}

export function createMergedIndexSourceRuntime(ctx: MergedIndexPageContext) {
  async function mergedIndexSourcesForRoots(
    roots: string[],
  ): Promise<MergedIndexSourceInfo[]> {
    const sources: MergedIndexSourceInfo[] = [];
    for (const rawRoot of roots) {
      const root = resolve(rawRoot);
      const indexDbPath = await ctx.activeRootIndexDbPathForRoot(root);
      if (!(await ctx.exists(indexDbPath))) throw new Error('merged-source-index-unavailable');
      const installDbPath = await ctx.installStatusDbPathForRoot(root);
      sources.push({
        root,
        indexDbPath,
        installDbPath,
        indexSignature: await ctx.rootIndexContentSignature(indexDbPath, root),
        installSignature: await ctx.installStatusContentSignature(installDbPath),
        sharedMetadataSignature: await ctx.sharedMetadataSignatureForRoot(root),
      });
    }
    for (const source of sources) assertFreshMergedIndexSource(source);
    return sources;
  }

  async function readMergedRowsForSource(
    source: MergedIndexSourceInfo,
    relativePaths?: string[],
  ): Promise<MergedIndexPageRow[]> {
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
      if (!hasInstallJoin && source.installSignature !== 'none') throw new Error('merged-install-projection-unavailable');
      const installColumns = hasInstallJoin
        ? ", install_status.installed AS installed, install_status.by_type AS installed_by, install_status.matches_json AS matches_json"
        : ", NULL AS installed, NULL AS installed_by, NULL AS matches_json";
      const joinSql = hasInstallJoin
        ? `LEFT JOIN install_db.install_status AS install_status ON ${rootIndexInstallJoinExpr(source.root)}`
        : "";
      const baseSql = `
        SELECT ? AS root_path, entries.relative_path, entries.cache_key, entries.file_size, entries.modified_at, entries.created_at,
               entries.status, entries.font_json, entries.message, entries.cached_at, COALESCE(entries.is_deleted, 0) AS is_deleted, NULL AS category_index, NULL AS search_text${installColumns}
        FROM entries
        ${joinSql}
        WHERE COALESCE(entries.is_deleted, 0) = 0 AND entries.status = 'ok' AND entries.font_json IS NOT NULL AND json_valid(entries.font_json)
      `;

      const cleanRelativePaths = Array.from(
        new Set(
          (relativePaths || [])
            .map((item) => String(item || "").replaceAll("\\", "/"))
            .filter(Boolean),
        ),
      );
      if (!cleanRelativePaths.length) {
        const rows = sourceDb.prepare(baseSql).all(source.root) as MergedIndexPageRow[];
        return ctx.applySharedMetadataToMergedRows(source.root, rows, true);
      }

      const rows: MergedIndexPageRow[] = [];
      for (let start = 0; start < cleanRelativePaths.length; start += 500) {
        const chunk = cleanRelativePaths.slice(start, start + 500);
        const placeholders = chunk.map(() => "?").join(",");
        rows.push(
          ...(sourceDb
            .prepare(`${baseSql} AND entries.relative_path IN (${placeholders})`)
            .all(source.root, ...chunk) as MergedIndexPageRow[]),
        );
      }
      return ctx.applySharedMetadataToMergedRows(source.root, rows, true);
    } finally {
      ctx.closeSqliteDb(sourceDb);
    }
  }

  function relativePathsFromFontIndexPayload(
    rootPath: string,
    payload: FontIndexChangePayload,
  ): string[] {
    return ctx.relativePathsFromFontIndexPayloadRuntime(
      rootPath,
      payload,
      ctx.cacheKeyForRootFile,
      ctx.pathInsideFolder,
    );
  }

  return {
    mergedIndexSourcesForRoots,
    readMergedRowsForSource,
    relativePathsFromFontIndexPayload,
  };
}
