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
    mergedIndexDbPath,
    openMergedIndexDb,
    scheduleMergedIndexBackgroundValidation:
      validationRuntime.scheduleMergedIndexBackgroundValidation,
    checkMergedIndexExternalChanges:
      validationRuntime.checkMergedIndexExternalChanges,
    syncMergedIndexAfterInstallStatusRefresh: (folders: string[]) =>
      validationRuntime.syncMergedIndexAfterInstallStatusRefresh(
        folders,
        syncRuntime.syncMergedIndexForRootSnapshot,
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
