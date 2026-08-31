export type RendererPerformanceTracePayload = {
  source?: string;
  kind?: string;
  label?: string;
  severity?: string;
  durationMs?: number;
  timestamp?: number;
  page?: string;
  details?: Record<string, unknown>;
};

export interface RendererInteractionRuntimeOptions {
  appendLog: (message: string) => void;
  onActivity?: () => void;
}

export interface RendererInteractionRuntime {
  markRendererUserActivity: (
    durationMs?: number,
    reason?: string,
  ) => { activeUntil: number; reason: string };
  reportRendererLongTask: (payload: {
    durationMs?: number;
    name?: string;
    startTime?: number;
    source?: string;
  }) => { ok: boolean };
  reportPerformanceEvent: (payload: RendererPerformanceTracePayload) => {
    ok: boolean;
  };
  isRendererUserActive: () => boolean;
  rendererIdleInMs: () => number;
  rendererActivityReason: () => string;
  waitForRendererIdle: (maxWaitMs?: number) => Promise<void>;
  flushPerformanceLogs: (reason?: string) => void;
}

function sanitizePerformanceTraceValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.startsWith('data:image/')) return `[data-url image length=${value.length}]`;
    const limit = depth > 0 ? 160 : 260;
    return value.length > limit ? `${value.slice(0, limit)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first: value.length
        ? sanitizePerformanceTraceValue(value[0], depth + 1)
        : undefined,
    };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).slice(0, 14)) {
      out[key] =
        depth >= 2
          ? typeof record[key]
          : sanitizePerformanceTraceValue(record[key], depth + 1);
    }
    return out;
  }
  return typeof value;
}


function rendererImmediateEventThreshold(kind: string, label: string): number | null {
  if (kind !== 'ipc-renderer') return null;
  if (label === 'fonts:getCachedPreviewImage') return 1600;
  if (label === 'fonts:getCachedPreviewImages') return 4000;
  if (label === 'fonts:renderPreviewImage') return 1400;
  if (label === 'fonts:checkSharedMetadataUpdates') return 1500;
  return null;
}

function performanceTraceDetails(details: unknown): string {
  try {
    return JSON.stringify(sanitizePerformanceTraceValue(details || {}));
  } catch {
    return "[unserializable]";
  }
}


type PerfAggregateBucket = {
  count: number;
  maxDurationMs: number;
  lastDurationMs: number;
  lastAt: number;
};

function aggregateKey(parts: Array<string | number | undefined>): string {
  return parts.map((part) => String(part || '').replace(/[|\n\r]/g, ' ').slice(0, 80)).join('|');
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolveDelay) =>
    setTimeout(resolveDelay, Math.max(0, ms)),
  );
}

export function createRendererInteractionRuntime(
  options: RendererInteractionRuntimeOptions,
): RendererInteractionRuntime {
  let rendererUserActivityUntil = 0;
  let rendererUserActivityReason = "";

  const detailedPerfLogs = process.env.HFM_LOG_DETAIL === "debug" || process.env.HFM_VERBOSE_LOGS === "1";
  const perfAggregates = new Map<string, PerfAggregateBucket>();
  let perfAggregateTimer: ReturnType<typeof setTimeout> | null = null;

  function flushPerfAggregates(reason: string): void {
    if (perfAggregateTimer) {
      clearTimeout(perfAggregateTimer);
      perfAggregateTimer = null;
    }
    if (!perfAggregates.size) return;
    const buckets = Array.from(perfAggregates.entries())
      .map(([key, value]) => ({ key, ...value }))
      .sort((a, b) => b.maxDurationMs - a.maxDurationMs || b.count - a.count)
      .slice(0, 6);
    const total = Array.from(perfAggregates.values()).reduce((sum, bucket) => sum + bucket.count, 0);
    perfAggregates.clear();
    options.appendLog(
      `renderer perf summary: reason=${reason}, suppressed=${total}, top=${JSON.stringify(buckets)}`,
    );
  }

  function recordPerfAggregate(key: string, durationMs: number): void {
    const now = Date.now();
    const bucket = perfAggregates.get(key) || { count: 0, maxDurationMs: 0, lastDurationMs: 0, lastAt: now };
    bucket.count += 1;
    bucket.maxDurationMs = Math.max(bucket.maxDurationMs, durationMs);
    bucket.lastDurationMs = durationMs;
    bucket.lastAt = now;
    perfAggregates.set(key, bucket);
    if (!perfAggregateTimer) {
      perfAggregateTimer = setTimeout(() => flushPerfAggregates("interval"), 30000);
      perfAggregateTimer.unref?.();
    }
    const flushAt = key.includes('fonts:getCachedPreviewImages') ? 200 : 50;
    if (bucket.count >= flushAt || perfAggregates.size >= 20) flushPerfAggregates("threshold");
  }

  const isRendererUserActive = (): boolean => Date.now() < rendererUserActivityUntil;
  const rendererIdleInMs = (): number => Math.max(0, rendererUserActivityUntil - Date.now());

  const markRendererUserActivity = (
    durationMs = 1200,
    reason = "interaction",
  ): { activeUntil: number; reason: string } => {
    const safeDuration = Math.max(
      200,
      Math.min(5000, Number(durationMs) || 1200),
    );
    rendererUserActivityUntil = Math.max(
      rendererUserActivityUntil,
      Date.now() + safeDuration,
    );
    rendererUserActivityReason = String(reason || "interaction").slice(0, 80);
    options.onActivity?.();
    return {
      activeUntil: rendererUserActivityUntil,
      reason: rendererUserActivityReason,
    };
  };

  const reportRendererLongTask = (payload: {
    durationMs?: number;
    name?: string;
    startTime?: number;
    source?: string;
  }): { ok: boolean } => {
    const durationMs = Math.round(Number(payload?.durationMs || 0));
    if (durationMs >= 50) {
      const name = String(payload?.name || "longtask").slice(0, 60);
      const source = String(payload?.source || "renderer").slice(0, 80);
      if (detailedPerfLogs || durationMs >= 120) {
        options.appendLog(
          `renderer long task: duration=${durationMs}ms, name=${name}, source=${source}`,
        );
      } else {
        recordPerfAggregate(aggregateKey(["longtask", source, name]), durationMs);
      }
      markRendererUserActivity(
        Math.min(4000, Math.max(1200, durationMs * 3)),
        "renderer-long-task",
      );
    }
    return { ok: true };
  };

  const reportPerformanceEvent = (payload: RendererPerformanceTracePayload): {
    ok: boolean;
  } => {
    const durationMs = Math.round(Number(payload?.durationMs || 0));
    const source = String(payload?.source || "renderer").slice(0, 40);
    const kind = String(payload?.kind || "event").slice(0, 60);
    const label = String(payload?.label || "").slice(0, 100);
    const severity = String(
      payload?.severity ||
        (durationMs >= 250 ? "warn" : durationMs >= 80 ? "slow" : "info"),
    ).slice(0, 24);
    const page = String(payload?.page || "").slice(0, 60);
    const immediateThreshold = rendererImmediateEventThreshold(kind, label);
    const shouldLogImmediate = detailedPerfLogs || severity === "error" || (immediateThreshold !== null ? durationMs >= immediateThreshold : severity === "warn" || durationMs >= 300);
    if (shouldLogImmediate) {
      options.appendLog(
        `renderer perf event: source=${source}, kind=${kind}, label=${label}, severity=${severity}, durationMs=${durationMs}, page=${page}, details=${performanceTraceDetails(payload?.details)}`,
      );
    } else if (durationMs >= 80 || severity === "slow") {
      recordPerfAggregate(aggregateKey([kind, source, label, page]), durationMs);
    }
    if (durationMs >= 50 || severity === "warn" || severity === "slow") {
      markRendererUserActivity(
        Math.min(5000, Math.max(1200, durationMs * 3)),
        `renderer-${kind}`,
      );
    }
    return { ok: true };
  };

  const waitForRendererIdle = async (maxWaitMs = 1600): Promise<void> => {
    const startedAt = Date.now();
    while (isRendererUserActive() && Date.now() - startedAt < maxWaitMs) {
      await delayMs(Math.min(120, Math.max(24, rendererIdleInMs())));
    }
  };

  return {
    markRendererUserActivity,
    reportRendererLongTask,
    reportPerformanceEvent,
    isRendererUserActive,
    rendererIdleInMs,
    rendererActivityReason: () => rendererUserActivityReason,
    waitForRendererIdle,
    flushPerformanceLogs: (reason = "manual") => flushPerfAggregates(reason),
  };
}
