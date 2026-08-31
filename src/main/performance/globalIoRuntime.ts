import {
createIoScheduler,
type GlobalIoOptions,
type IoQueueSnapshot,
} from "./ioScheduler";
import type { StorageProfile } from "./storageProfile";
import { shouldLogSuccessfulGlobalIo } from './globalIoLogPolicyRuntime';

export interface GlobalIoRuntimeOptions {
  env: NodeJS.ProcessEnv;
  localScanWorkers: number;
  appendLog: (message: string) => void;
  isIndexingActive: () => boolean;
  isUserActive: () => boolean;
  storageProfileForPath: (filePath: string) => StorageProfile;
}

export interface GlobalIoRuntime {
  recheckGlobalIoQueues: () => void;
  globalIoSnapshot: () => IoQueueSnapshot;
  withGlobalIo: <T>(
    label: string,
    fn: () => Promise<T>,
    options?: GlobalIoOptions,
  ) => Promise<T>;
  ioLaneSummary: () => string;
}

function detailedGlobalIoLogsEnabled(env: NodeJS.ProcessEnv): boolean {
  const detail = String(env.HFM_LOG_DETAIL || '').trim().toLowerCase()
  return env.HFM_VERBOSE_LOGS === '1' || detail === 'debug' || detail === 'verbose' || detail === 'full'
}

function compactIoSnapshot(snapshot: IoQueueSnapshot): string {
  const laneSummary = Object.entries(snapshot.lanes)
    .filter(([, lane]) => lane.active > 0 || lane.pending > 0)
    .map(([name, lane]) => `${name}:${lane.active}/${lane.pending}/${lane.concurrency}`)
    .join('|')
  return `active=${snapshot.active},pending=${snapshot.pending},concurrency=${snapshot.concurrency}${laneSummary ? `,lanes=${laneSummary}` : ''}`
}

function slowIoLogThresholdMs(label: string, priority: string): number {
  if (label === 'scan:stat-font') return 2000
  if (label === 'index:stat-font') return 1500
  if (label === 'scan:stat-dir') return 1500
  if (label === 'scan:read-dir') return 1000
  if (label === 'preview:render') return priority === 'foreground' ? 800 : 1200
  if (label === 'watch:preflight-stat') return 2000
  if (label.startsWith('watch:')) return 1200
  if (priority === 'background') return 600
  return 300
}

export function createGlobalIoRuntime(
  options: GlobalIoRuntimeOptions,
): GlobalIoRuntime {
  const idleConcurrency = Math.max(
    1,
    Math.min(4, Number(options.env.HFM_IO_WORKERS || 3) || 3),
  );
  const indexingConcurrency = Math.max(
    1,
    Math.min(2, Number(options.env.HFM_IO_WORKERS_INDEXING || 2) || 2),
  );
  const networkConcurrency = Math.max(
    1,
    Math.min(3, Number(options.env.HFM_IO_NETWORK_WORKERS || 1) || 1),
  );
  const hddConcurrency = Math.max(
    1,
    Math.min(4, Number(options.env.HFM_IO_HDD_WORKERS || 2) || 2),
  );
  const ssdConcurrency = Math.max(
    1,
    Math.min(
      8,
      Number(
        options.env.HFM_IO_SSD_WORKERS ||
          Math.max(idleConcurrency, Math.min(6, options.localScanWorkers)),
      ) || idleConcurrency,
    ),
  );
  const nvmeConcurrency = Math.max(
    1,
    Math.min(
      12,
      Number(
        options.env.HFM_IO_NVME_WORKERS ||
          Math.max(ssdConcurrency, options.localScanWorkers),
      ) || ssdConcurrency,
    ),
  );
  const removableConcurrency = Math.max(
    1,
    Math.min(3, Number(options.env.HFM_IO_REMOVABLE_WORKERS || 1) || 1),
  );
  const sqliteWriteConcurrency = 1;
  const detailedIoLogs = detailedGlobalIoLogsEnabled(options.env);

  const ioScheduler = createIoScheduler({
    idleConcurrency,
    indexingConcurrency,
    networkConcurrency,
    hddConcurrency,
    ssdConcurrency,
    nvmeConcurrency,
    removableConcurrency,
    sqliteWriteConcurrency,
    localScanWorkers: options.localScanWorkers,
    isIndexingActive: options.isIndexingActive,
    isUserActive: options.isUserActive,
    storageProfileForPath: options.storageProfileForPath,
  });

  function recheckGlobalIoQueues(): void {
    ioScheduler.recheck();
  }

  function globalIoSnapshot(): IoQueueSnapshot {
    return ioScheduler.snapshot();
  }

  function withGlobalIo<T>(
    label: string,
    fn: () => Promise<T>,
    taskOptions: GlobalIoOptions = {},
  ): Promise<T> {
    const startedAt = Date.now();
    const before = ioScheduler.snapshot();
    const shouldTraceStart =
      detailedIoLogs && (before.pending > 0 || before.active >= before.concurrency);
    if (shouldTraceStart) {
      options.appendLog(
        `perf io start: label=${label}, lane=${String(taskOptions.lane || "auto")}, priority=${String(taskOptions.priority || "normal")}, storagePath=${String(taskOptions.storagePath || "").slice(0, 180)}, before=${JSON.stringify(before)}`,
      );
    }
    return ioScheduler
      .withGlobalIo(label, fn, taskOptions)
      .then((result) => {
        const durationMs = Date.now() - startedAt;
        const after = ioScheduler.snapshot();
        const priority = String(taskOptions.priority || 'normal')
        const thresholdMs = slowIoLogThresholdMs(label, priority)
        if (shouldLogSuccessfulGlobalIo({ label, durationMs, thresholdMs, shouldTraceStart, after })) {
          const base = `perf io end: label=${label}, status=ok, durationMs=${durationMs}, thresholdMs=${thresholdMs}, lane=${String(taskOptions.lane || "auto")}, priority=${priority}`
          if (detailedIoLogs) {
            options.appendLog(
              `${base}, storagePath=${String(taskOptions.storagePath || "").slice(0, 180)}, after=${JSON.stringify(after)}`,
            );
          } else {
            options.appendLog(`${base}, queue=${compactIoSnapshot(after)}`);
          }
        }
        return result;
      })
      .catch((error) => {
        const durationMs = Date.now() - startedAt;
        options.appendLog(
          `perf io end: label=${label}, status=failed, durationMs=${durationMs}, lane=${String(taskOptions.lane || "auto")}, priority=${String(taskOptions.priority || "normal")}, storagePath=${String(taskOptions.storagePath || "").slice(0, 180)}, error=${error instanceof Error ? error.message : String(error)}, after=${JSON.stringify(ioScheduler.snapshot())}`,
        );
        throw error;
      });
  }

  function ioLaneSummary(): string {
    return `io lanes: globalIdle=${idleConcurrency} globalIndexing=${indexingConcurrency} userActive=1/2 network=${networkConcurrency} hdd=${hddConcurrency} ssd=${ssdConcurrency} nvme=${nvmeConcurrency} removable=${removableConcurrency} sqlite=${sqliteWriteConcurrency}`;
  }

  return {
    recheckGlobalIoQueues,
    globalIoSnapshot,
    withGlobalIo,
    ioLaneSummary,
  };
}
