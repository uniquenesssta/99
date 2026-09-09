import { createGlobalIoRuntime, type GlobalIoRuntimeOptions } from "./globalIoRuntime";
import { createRendererInteractionRuntime } from "./rendererInteractionRuntime";
import { createRuntimePerformanceSampler } from "./runtimePerformanceSampler";

export type MainPerformanceRuntimeOptions = Pick<GlobalIoRuntimeOptions,
  'env' | 'localScanWorkers' | 'isIndexingActive' | 'storageProfileForPath'
> & {
  appendStartupLog: (message: string) => void;
  activeScanJobId: () => string;
  isInstallStatusRefreshActive: () => boolean;
  activeBackgroundTaskCount: () => number;
};

export function createMainPerformanceRuntime(deps: MainPerformanceRuntimeOptions) {
  let recheckGlobalIoQueuesRef: () => void = () => undefined;

  const rendererInteractionRuntime = createRendererInteractionRuntime({
    appendLog: deps.appendStartupLog,
    onActivity: () => recheckGlobalIoQueuesRef(),
  });

  const globalIoRuntime = createGlobalIoRuntime({
    env: deps.env,
    localScanWorkers: deps.localScanWorkers,
    appendLog: deps.appendStartupLog,
    isIndexingActive: deps.isIndexingActive,
    isUserActive: rendererInteractionRuntime.isRendererUserActive,
    storageProfileForPath: deps.storageProfileForPath,
  });

  const { recheckGlobalIoQueues, globalIoSnapshot, withGlobalIo, ioLaneSummary } =
    globalIoRuntime;
  recheckGlobalIoQueuesRef = recheckGlobalIoQueues;

  const rendererActivityReason = (): string =>
    rendererInteractionRuntime.rendererActivityReason();

  const runtimePerformanceSampler = createRuntimePerformanceSampler({
    appendLog: deps.appendStartupLog,
    ioSnapshot: globalIoSnapshot,
    rendererActive: rendererInteractionRuntime.isRendererUserActive,
    rendererIdleInMs: rendererInteractionRuntime.rendererIdleInMs,
    rendererActivityReason,
    scanActive: deps.isIndexingActive,
    scanJob: deps.activeScanJobId,
    installRefreshActive: deps.isInstallStatusRefreshActive,
    backgroundTasksActive: deps.activeBackgroundTaskCount,
  });

  return {
    markRendererUserActivity: rendererInteractionRuntime.markRendererUserActivity,
    reportRendererLongTask: rendererInteractionRuntime.reportRendererLongTask,
    reportPerformanceEvent: rendererInteractionRuntime.reportPerformanceEvent,
    isRendererUserActive: rendererInteractionRuntime.isRendererUserActive,
    rendererIdleInMs: rendererInteractionRuntime.rendererIdleInMs,
    waitForRendererIdle: rendererInteractionRuntime.waitForRendererIdle,
    rendererActivityReason,
    recheckGlobalIoQueues,
    globalIoSnapshot,
    withGlobalIo,
    ioLaneSummary,
    startPerformanceLogSampler: runtimePerformanceSampler.start,
    stopPerformanceLogSampler: runtimePerformanceSampler.stop,
    flushPerformanceLogs: rendererInteractionRuntime.flushPerformanceLogs,
  };
}
