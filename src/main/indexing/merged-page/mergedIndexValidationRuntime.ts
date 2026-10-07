import type { MergedIndexSourceInfo } from '../mergedIndexRuntime';
import { withoutSharedIoSignal } from '../../path/sharedFileSystemRuntime';
import { runtimeFontIdFromEntry } from '../../fonts/fontFileIdentity';
import type { FontItem, FontIndexChangePayload } from "../../../shared/types";
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
    const task = withoutSharedIoSignal(async () => {
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
    });
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
    items?: FontItem[],
    syncIncremental?: (root: string, payload: FontIndexChangePayload, reason: string) => Promise<void>,
  ): Promise<void> {
    if (items) {
      await ctx.runMergedIndexMutation('local-install-status', async ({ commit }) => {
        const currentItems = ctx.readInstallStatusForProjection ? await ctx.readInstallStatusForProjection(items) : items;
        const db = await ctx.openMergedIndexDb();
        try {
          type Row = { root_path: string; relative_path: string; file_size: number; modified_at: number };
          const wanted = new Set(currentItems.map(item => item.id));
          const rows = db.prepare("SELECT root_path, relative_path, file_size, modified_at FROM entries WHERE COALESCE(is_deleted,0)=0 AND status='ok' AND json_valid(font_json)").all() as Row[];
          const targets = new Map<string, Row[]>();
          let invalidRows = 0;
          // One bounded population pass per committed batch, then primary-key
          // updates. Never execute the SHA-1 SQL function for every row x item.
          for (const row of rows) {
            try {
              const id = runtimeFontIdFromEntry(row.root_path, row.relative_path, row.file_size, row.modified_at);
              if (wanted.has(id)) targets.set(id, [...(targets.get(id) || []), row]);
            } catch { invalidRows++; }
          }
          const sourceRows = db.prepare('SELECT * FROM sources').all() as Array<{
            root_path: string; index_db_path: string; install_db_path?: string; index_signature: string;
            install_signature: string; shared_metadata_signature: string;
          }>;
          const sources: MergedIndexSourceInfo[] = sourceRows.map(row => ({ root: row.root_path,
            indexDbPath: row.index_db_path, installDbPath: row.install_db_path || undefined,
            indexSignature: row.index_signature, installSignature: row.install_signature,
            sharedMetadataSignature: row.shared_metadata_signature }));
          const previousSourcesKey = ctx.mergedIndexSourcesKey(sources);
          const signatures = new Map<string, string>();
          for (const source of sources) {
            const path = source.installDbPath || '';
            if (!signatures.has(path)) signatures.set(path, await ctx.installStatusContentSignature(source.installDbPath));
          }
          const nextSources = sources.map(source => ({ ...source, installSignature: signatures.get(source.installDbPath || '')! }));
          const update = db.prepare(`UPDATE entries SET installed = ?, installed_by = ?, matches_json = ?
            WHERE root_path=? AND relative_path=? AND file_size=? AND modified_at=?
              AND (installed IS NOT ? OR installed_by IS NOT ? OR matches_json IS NOT ?)`);
          db.exec('BEGIN IMMEDIATE');
          try {
            let changed = 0;
            for (const item of currentItems) {
              const permanentBy = item.systemInstallMatches?.some(match => match.source === 'HKLM' || match.source === 'WindowsFontsFolder') ? 'system' : 'user';
              const by = item.active ? (item.systemInstalled ? 'both' : 'managed') : item.systemInstalled ? permanentBy : 'none';
              const installed = item.installStatusKnown === true ? item.active || item.systemInstalled ? 1 : 0 : null;
              const knownBy = item.installStatusKnown === true ? by : null;
              const matches = item.installStatusKnown === true ? JSON.stringify(item.systemInstallMatches || []) : null;
              for (const row of targets.get(item.id) || []) changed += Number(update.run(installed, knownBy, matches,
                row.root_path, row.relative_path, row.file_size, row.modified_at, installed, knownBy, matches).changes || 0);
            }
            // Acknowledge exactly the install source projected by this writer.
            // Never bless an unrelated pending root/metadata change.
            if (sources.length && ctx.getSqliteMeta(db, 'sourcesKey') === previousSourcesKey) {
              const now = new Date().toISOString();
              for (const source of nextSources) ctx.writeMergedIndexSourceRow(db, source, now);
              ctx.setSqliteMeta(db, 'sourcesKey', ctx.mergedIndexSourcesKey(nextSources));
              ctx.setSqliteMeta(db, 'updatedAt', now);
            }
            db.exec('COMMIT');
            if (changed) commit('local-install-status');
            ctx.appendStartupLog(`local install projection batch: examined=${rows.length}, requested=${currentItems.length}, targets=${targets.size}, changed=${changed}, invalidRows=${invalidRows}`);
          } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
        } finally { ctx.closeSqliteDb(db); }
      });
      return;
    }
    const roots = Array.from(
      new Set((folders || []).filter(Boolean).map((folder) => resolve(folder))),
    );
    if (!roots.length) return;
    const startedAt = Date.now();
    for (const root of roots) {
      try {
        if (items && syncIncremental) {
          await syncIncremental(root, { folder: root, at: new Date().toISOString(), upserts: items, deletes: [] }, "install-status-refresh");
        } else {
          await syncMergedIndexForRootSnapshot(root, "install-status-refresh");
        }
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
