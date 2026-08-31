import {
normalizeTaskType,
taskRecordToSummary,
type BackgroundTaskRecord,
} from "./backgroundTasks";

type BackgroundTaskEventType =
  | "started"
  | "progress"
  | "finished"
  | "failed"
  | "skipped"
  | "scheduler";

export type BackgroundTaskSchedulerStatus = {
  running: boolean;
  stopping: boolean;
  startedAt: string | null;
  active: number;
  activeTaskKeys: string[];
  intervalMs: number;
  concurrency: number;
  userActive: boolean;
  userIdleInMs: number;
  userActivityReason: string;
};

type BackgroundTaskRunner = (task: BackgroundTaskRecord) => Promise<void>;

type BackgroundTaskSchedulerRuntimeOptions = {
  intervalMs: number;
  concurrency: number;
  batchSize: number;
  startDelayMs: number;
  recoverScanTasks: boolean;
  appendLog: (message: string) => void;
  sendEvent: (
    eventType: BackgroundTaskEventType,
    payload?: Record<string, unknown>,
  ) => void;
  isUserActive: () => boolean;
  userIdleInMs: () => number;
  userActivityReason: () => string;
  readDueTasks: (
    limit: number,
    options: { recoverScanTasks: boolean },
  ) => Promise<BackgroundTaskRecord[]>;
  startTask: (taskKey: string) => Promise<BackgroundTaskRecord | null>;
  skipTask: (taskKey: string, message: string) => Promise<unknown>;
  failTask: (
    taskKey: string,
    message: string,
    stack?: string,
  ) => Promise<unknown>;
  taskRunners: Record<string, BackgroundTaskRunner>;
};

export type BackgroundTaskSchedulerRuntime = {
  activeCount: () => number;
  emitEvent: (
    eventType: BackgroundTaskEventType,
    payload?: Record<string, unknown>,
  ) => void;
  status: () => BackgroundTaskSchedulerStatus;
  runOnce: () => Promise<void>;
  start: () => void;
  stop: () => void;
};

export function createBackgroundTaskSchedulerRuntime(
  options: BackgroundTaskSchedulerRuntimeOptions,
): BackgroundTaskSchedulerRuntime {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let stopping = false;
  let startedAt: string | null = null;
  const activeTaskKeys = new Set<string>();

  function emitEvent(
    eventType: BackgroundTaskEventType,
    payload: Record<string, unknown> = {},
  ): void {
    options.sendEvent(eventType, {
      at: new Date().toISOString(),
      ...payload,
    });
  }

  function status(): BackgroundTaskSchedulerStatus {
    return {
      running: !!timer && !stopping,
      stopping,
      startedAt,
      active: activeTaskKeys.size,
      activeTaskKeys: Array.from(activeTaskKeys),
      intervalMs: options.intervalMs,
      concurrency: options.concurrency,
      userActive: options.isUserActive(),
      userIdleInMs: options.userIdleInMs(),
      userActivityReason: options.userActivityReason(),
    };
  }

  async function executeTask(task: BackgroundTaskRecord): Promise<void> {
    const started = await options.startTask(task.task_key);
    if (!started) return;
    activeTaskKeys.add(task.task_key);
    emitEvent("started", { task: taskRecordToSummary(started) });
    try {
      const type = started.type || normalizeTaskType(started.name);
      const runner = options.taskRunners[type];
      if (runner) {
        await runner(started);
      } else {
        await options.skipTask(
          started.task_key,
          `未知后台任务类型：${type}`,
        );
      }
      emitEvent("finished", { taskKey: started.task_key, type });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options
        .failTask(
          started.task_key,
          message,
          error instanceof Error ? error.stack : undefined,
        )
        .catch(() => undefined);
      options.appendLog(`background task failed: ${started.task_key} ${message}`);
      emitEvent("failed", { taskKey: started.task_key, message });
    } finally {
      activeTaskKeys.delete(task.task_key);
    }
  }

  async function runOnce(): Promise<void> {
    if (stopping) return;
    if (options.isUserActive()) return;
    if (running) return;
    if (activeTaskKeys.size >= options.concurrency) return;
    running = true;
    try {
      const capacity = options.concurrency - activeTaskKeys.size;
      const tasks = (
        await options.readDueTasks(Math.min(options.batchSize, capacity), {
          recoverScanTasks: options.recoverScanTasks,
        })
      ).filter((task) => !activeTaskKeys.has(task.task_key));
      for (const task of tasks) {
        void executeTask(task);
      }
    } catch (error) {
      options.appendLog(
        `background task scheduler tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) return;
    stopping = false;
    startedAt = new Date().toISOString();
    timer = setInterval(() => {
      void runOnce();
    }, options.intervalMs);
    timer.unref?.();
    setTimeout(() => void runOnce(), options.startDelayMs).unref?.();
    options.appendLog(
      `background task scheduler started: concurrency=${options.concurrency}, intervalMs=${options.intervalMs}`,
    );
    emitEvent("scheduler", { status: status() });
  }

  function stop(): void {
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    options.appendLog(
      `background task scheduler stopped: active=${activeTaskKeys.size}`,
    );
    emitEvent("scheduler", { status: status() });
  }

  return {
    activeCount: () => activeTaskKeys.size,
    emitEvent,
    status,
    runOnce,
    start,
    stop,
  };
}
