import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import {
DB_QUERY_WORKER_IDLE_TIMEOUT_MS,
DB_QUERY_WORKER_VERSION,
} from "./dbQueryWorkerConstants";
import { summarizeDbWorkerPayload } from "./dbQueryWorkerPayloadSummary";
import { buildDbQueryWorkerSource } from "./dbQueryWorkerSourceRuntime";
import type {
DbQueryWorkerRuntimeDeps,
DbWorkerRequestMessage,
DbWorkerResponseMessage,
DbWorkerResult,
PendingRequest,
QueryMergedIndexMetricsWorkerRequest,
QueryMergedIndexMetricsWorkerResult,
QueryMergedIndexPageWorkerRequest,
QueryMergedIndexPageWorkerResult,
ReadInstallStatusWorkerRequest,
ReadInstallStatusWorkerResult,
SaveInstallStatusWorkerRequest,
SaveInstallStatusWorkerResult,
} from "./dbQueryWorkerTypes";

export function createDbQueryWorkerClientRuntime(deps: DbQueryWorkerRuntimeDeps) {
  let worker: Worker | null = null;
  let workerReady: Promise<Worker> | null = null;
  let nextRequestId = 1;
  const pending = new Map<number, PendingRequest<any>>();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let expectedShutdown = false;

  function workerPath(): string {
    return deps.dataPath("runtime", `db-query-worker-${DB_QUERY_WORKER_VERSION}.cjs`);
  }

  async function ensureWorkerScript(): Promise<string> {
    const filePath = workerPath();
    await fsp.mkdir(dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, buildDbQueryWorkerSource(), "utf-8");
    return filePath;
  }
  function resolveWorkerBetterSqlite3ModulePath(): string {
    try {
      return deps.resolveModulePath?.("better-sqlite3") || "better-sqlite3";
    } catch (error) {
      deps.appendStartupLog(
        `db query worker module resolve fallback: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "better-sqlite3";
    }
  }

  function workerEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      HFM_BETTER_SQLITE3_MODULE: resolveWorkerBetterSqlite3ModulePath(),
    };
  }


  function clearIdleTimer(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  }

  function scheduleIdleShutdown(): void {
    clearIdleTimer();
    if (pending.size > 0) return;
    idleTimer = setTimeout(() => {
      if (pending.size > 0) return;
      deps.appendStartupLog(
        `perf db-worker idle shutdown: pending=0, idleMs=${DB_QUERY_WORKER_IDLE_TIMEOUT_MS}`,
      );
      shutdown();
    }, DB_QUERY_WORKER_IDLE_TIMEOUT_MS);
  }

  function rejectAllPending(error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }

  async function ensureWorker(): Promise<Worker> {
    clearIdleTimer();
    if (worker) return worker;
    if (workerReady) return workerReady;
    workerReady = (async () => {
      const scriptPath = await ensureWorkerScript();
      const created = new Worker(scriptPath, { env: workerEnv() });
      expectedShutdown = false;
      created.on("message", (message: DbWorkerResponseMessage) => {
        const id = Number(message?.id || 0);
        const request = pending.get(id);
        if (!request) return;
        pending.delete(id);
        const durationMs = Date.now() - request.startedAt;
        if (message.ok) {
          const resultWithTimings = message.result as DbWorkerResult & {
            timings?: Record<string, number>;
            total?: number;
            items?: unknown[];
            missingIds?: unknown[];
            written?: number;
          };
          deps.appendStartupLog(
            `perf db-worker response: id=${id}, status=ok, type=${request.type}, durationMs=${durationMs}, pending=${pending.size}, total=${String(resultWithTimings.total ?? "")}, items=${Array.isArray(resultWithTimings.items) ? resultWithTimings.items.length : ""}, missing=${Array.isArray(resultWithTimings.missingIds) ? resultWithTimings.missingIds.length : ""}, written=${String(resultWithTimings.written ?? "")}, timings=${JSON.stringify(resultWithTimings.timings || {})}`,
          );
          request.resolve(message.result);
        } else {
          deps.appendStartupLog(
            `perf db-worker response: id=${id}, status=failed, type=${request.type}, durationMs=${durationMs}, pending=${pending.size}, error=${message.error || "db query worker failed"}`,
          );
          const error = new Error(message.error || "db query worker failed");
          if (message.code) {
            (error as Error & { code?: string }).code = message.code;
          }
          request.reject(error);
        }
        scheduleIdleShutdown();
      });
      created.on("error", (error) => {
        deps.appendStartupLog(
          `db query worker error: ${error instanceof Error ? error.message : String(error)}`,
        );
        rejectAllPending(error instanceof Error ? error : new Error(String(error)));
        worker = null;
        workerReady = null;
      });
      created.on("exit", (code) => {
        if (expectedShutdown && pending.size === 0) {
          deps.appendStartupLog(`perf db-worker exited: code=${code}, expected=true`);
        } else {
          deps.appendStartupLog(
            `perf db-worker exited: code=${code}, expected=false, pending=${pending.size}`,
          );
          rejectAllPending(new Error(`db query worker exited: ${code}`));
        }
        expectedShutdown = false;
        worker = null;
        workerReady = null;
      });
      worker = created;
      deps.appendStartupLog("db query worker started");
      return created;
    })();
    try {
      return await workerReady;
    } finally {
      workerReady = null;
    }
  }

  async function callWorker<T extends DbWorkerResult>(
    message: Omit<DbWorkerRequestMessage, "id">,
  ): Promise<T> {
    const activeWorker = await ensureWorker();
    const id = nextRequestId++;
    return await new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject,
        startedAt: Date.now(),
        type: message.type,
      });
      deps.appendStartupLog(
        `perf db-worker request: id=${id}, type=${message.type}, pending=${pending.size}, payload=${summarizeDbWorkerPayload(message)}`,
      );
      activeWorker.postMessage({ ...message, id } as DbWorkerRequestMessage);
    });
  }

  async function prewarm(): Promise<void> {
    await ensureWorker();
    scheduleIdleShutdown();
  }

  async function queryMergedIndexPage(
    payload: QueryMergedIndexPageWorkerRequest,
  ): Promise<QueryMergedIndexPageWorkerResult> {
    return await callWorker<QueryMergedIndexPageWorkerResult>({
      type: "queryMergedIndexPage",
      payload,
    });
  }

  async function queryMergedIndexMetrics(
    payload: QueryMergedIndexMetricsWorkerRequest,
  ): Promise<QueryMergedIndexMetricsWorkerResult> {
    return await callWorker<QueryMergedIndexMetricsWorkerResult>({
      type: "queryMergedIndexMetrics",
      payload,
    });
  }

  async function readInstallStatusIndex(
    payload: ReadInstallStatusWorkerRequest,
  ): Promise<ReadInstallStatusWorkerResult> {
    return await callWorker<ReadInstallStatusWorkerResult>({
      type: "readInstallStatusIndex",
      payload,
    });
  }

  async function saveInstallStatusIndex(
    payload: SaveInstallStatusWorkerRequest,
  ): Promise<SaveInstallStatusWorkerResult> {
    return await callWorker<SaveInstallStatusWorkerResult>({
      type: "saveInstallStatusIndex",
      payload,
    });
  }

  function shutdown(): void {
    clearIdleTimer();
    const active = worker;
    worker = null;
    workerReady = null;
    if (active) {
      expectedShutdown = true;
      active.terminate().catch(() => undefined);
    }
  }

  return {
    prewarm,
    queryMergedIndexPage,
    queryMergedIndexMetrics,
    readInstallStatusIndex,
    saveInstallStatusIndex,
    shutdown,
  };
}
