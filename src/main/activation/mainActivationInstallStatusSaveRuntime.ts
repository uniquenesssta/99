import {
createActivationInstallStatusSaveQueue,
type ActivationInstallStatusSaveQueueDeps,
} from "./activationInstallStatusSaveQueue";

export type MainActivationInstallStatusSaveRuntimeOptions = ActivationInstallStatusSaveQueueDeps;

export type MainActivationInstallStatusSaveRuntime = {
  scheduleActivationInstallStatusSave: ReturnType<
    typeof createActivationInstallStatusSaveQueue
  >["schedule"];
  flushActivationInstallStatusSave: ReturnType<
    typeof createActivationInstallStatusSaveQueue
  >["flush"];
  hasPendingActivationInstallStatusSave: ReturnType<
    typeof createActivationInstallStatusSaveQueue
  >["hasPending"];
  hasInFlightActivationInstallStatusSave: ReturnType<
    typeof createActivationInstallStatusSaveQueue
  >["hasInFlight"];
};

export function createMainActivationInstallStatusSaveRuntime(
  options: MainActivationInstallStatusSaveRuntimeOptions,
): MainActivationInstallStatusSaveRuntime {
  const queue = createActivationInstallStatusSaveQueue({
    saveInstallStatusIndex: options.saveInstallStatusIndex,
    appWatchedFolders: options.appWatchedFolders,
    rootForFontPath: options.rootForFontPath,
    syncMergedIndexAfterInstallStatusRefresh:
      options.syncMergedIndexAfterInstallStatusRefresh,
    clearFontQueryCaches: options.clearFontQueryCaches,
    appendStartupLog: options.appendStartupLog,
    batchDelayMs: options.batchDelayMs ?? 500,
  });

  return {
    scheduleActivationInstallStatusSave: queue.schedule,
    flushActivationInstallStatusSave: queue.flush,
    hasPendingActivationInstallStatusSave: queue.hasPending,
    hasInFlightActivationInstallStatusSave: queue.hasInFlight,
  };
}
