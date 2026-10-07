import type { FontItem } from "../../shared/types";
import { createMergedIndexBuildRuntime } from "./merged-page/mergedIndexBuildRuntime";
import { createMergedIndexMutationCoordinatorRuntime } from "./merged-page/mergedIndexMutationCoordinatorRuntime";
import { createMergedIndexPageQueryRuntime } from "./merged-page/mergedIndexPageQueryRuntime";
import type {
  CreateMergedIndexPageRuntimeOptions,
  MergedIndexPageContext,
} from "./merged-page/mergedIndexPageTypes";
import { createMergedIndexSourceRuntime } from "./merged-page/mergedIndexSourceRuntime";
import { createMergedIndexSyncRuntime } from "./merged-page/mergedIndexSyncRuntime";
import { createMergedIndexValidationRuntime } from "./merged-page/mergedIndexValidationRuntime";
import { createMergedIndexRuntime } from "./mergedIndexRuntime";

export type MergedIndexPageRuntime = ReturnType<
  typeof createMergedIndexPageRuntime
>;

export function createMergedIndexPageRuntime(
  options: CreateMergedIndexPageRuntimeOptions,
) {
  const mergedIndexRuntime = createMergedIndexRuntime(options);
  const mutationCoordinator = createMergedIndexMutationCoordinatorRuntime({
    appendStartupLog: options.appendStartupLog,
    onCommitted: options.onMergedIndexCommitted,
  });
  const {
    mergedIndexDbPath,
    rootIndexContentSignature,
    installStatusContentSignature,
    openMergedIndexDb,
    mergedIndexSourcesKey,
    mergedIndexRootsKey,
    mergedIndexLocalSnapshotUsable,
    mergedIndexInsertStatement,
    writeMergedIndexSourceRow,
    bindMergedIndexRow,
    mergedIndexSourcesMatchRoots,
    ensureMergedIndexPendingSnapshotForRoots,
    relativePathsFromFontIndexPayload: relativePathsFromFontIndexPayloadRuntime,
  } = mergedIndexRuntime;

  const context: MergedIndexPageContext = {
    ...options,
    mergedIndexDbPath,
    rootIndexContentSignature,
    installStatusContentSignature,
    openMergedIndexDb,
    mergedIndexSourcesKey,
    mergedIndexRootsKey,
    mergedIndexLocalSnapshotUsable,
    mergedIndexInsertStatement,
    writeMergedIndexSourceRow,
    bindMergedIndexRow,
    mergedIndexSourcesMatchRoots,
    ensureMergedIndexPendingSnapshotForRoots,
    relativePathsFromFontIndexPayloadRuntime,
    mergedIndexRebuildInFlight: new Map(),
    mergedIndexReadyProcessKeys: new Set(),
    mergedIndexValidateInFlight: new Map(),
    mergedIndexLastValidateAt: new Map(),
    runMergedIndexMutation: mutationCoordinator.runMergedIndexMutation,
    waitForMergedIndexMutations: mutationCoordinator.waitForMergedIndexMutations,
  };

  const sourceRuntime = createMergedIndexSourceRuntime(context);
  const buildRuntime = createMergedIndexBuildRuntime(context);
  mergedIndexRuntime.setMergedIndexRecoveryBuilder(async (db, targetPath) => {
    const roots = await context.appWatchedFolders();
    const sources = await sourceRuntime.mergedIndexSourcesForRoots(roots);
    if (!roots.length || context.mergedIndexRootsKey(sources.map(source => source.root)) !== context.mergedIndexRootsKey(roots)) {
      throw new Error('监听根索引尚未全部可用，暂不替换合并索引。');
    }
    const sourceKey = context.mergedIndexSourcesKey(sources);
    await buildRuntime.rebuildMergedIndexDb(db, sources, sourceKey, targetPath);
    const actual = db.prepare('SELECT COUNT(*) AS count FROM entries').get();
    let expected = 0;
    for (const source of sources) {
      const sourceDb = await context.openRootIndexDb(source.indexDbPath, source.root, 'root', false);
      try { expected += Number(sourceDb.prepare("SELECT COUNT(*) AS count FROM entries WHERE COALESCE(is_deleted,0)=0 AND status='ok' AND font_json IS NOT NULL AND json_valid(font_json)").get()?.count || 0); }
      finally { context.closeSqliteDb(sourceDb); }
    }
    if (Number(actual?.count) !== expected) throw new Error('合并索引恢复条目计数不一致，保留原文件。');
  });
  const validationRuntime = createMergedIndexValidationRuntime(
    context,
    sourceRuntime,
    buildRuntime,
  );
  const syncRuntime = createMergedIndexSyncRuntime(
    context,
    sourceRuntime,
    buildRuntime,
  );
  const queryRuntime = createMergedIndexPageQueryRuntime(
    context,
    sourceRuntime,
    buildRuntime,
    validationRuntime.scheduleMergedIndexBackgroundValidation,
  );

  return {
    ensureMergedIndexReadyForWorker: queryRuntime.ensureMergedIndexReadyForWorker,
    mergedIndexDbPath,
    openMergedIndexDb,
    scheduleMergedIndexBackgroundValidation:
      validationRuntime.scheduleMergedIndexBackgroundValidation,
    checkMergedIndexExternalChanges:
      validationRuntime.checkMergedIndexExternalChanges,
    syncMergedIndexAfterInstallStatusRefresh: (folders: string[], items?: FontItem[]) =>
      validationRuntime.syncMergedIndexAfterInstallStatusRefresh(
        folders,
        syncRuntime.syncMergedIndexForRootSnapshot,
        items,
        syncRuntime.syncMergedIndexForRootIncremental,
      ),
    syncMergedIndexForRootIncremental:
      syncRuntime.syncMergedIndexForRootIncremental,
    syncMergedIndexForRootSnapshot: syncRuntime.syncMergedIndexForRootSnapshot,
    queryFontPageFromMergedIndexWorker:
      queryRuntime.queryFontPageFromMergedIndexWorker,
    queryFontPageFromMergedIndex: queryRuntime.queryFontPageFromMergedIndex,
    waitForMergedIndexMutations: mutationCoordinator.waitForMergedIndexMutations,
  };
}
