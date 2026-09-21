import { createManagedActivationIdentityRuntime, safeManagedActivationPath } from './runtime/managedActivationIdentityRuntime';
import type { FontActivationRuntimeDeps } from './runtime/fontActivationTypes';
import { createLocalRecoveryFileRuntime, isTemporaryActiveFontRecord } from "./runtime/localRecoveryFileRuntime";
import { promises as fsp } from "node:fs";
import type { GlobalIoOptions } from "../performance/ioScheduler";
import type { TemporaryActiveFontRecord } from "../windows/fontRuntime";
import {
  logNodeBridgeFallbackDisabled,
  logNodeBridgeFallbackUsed,
  nodeBridgeFallbackCompatibilityAllowed,
} from "../rust-core/nodeBridgeFallbackCompatibilityRuntime";

export interface PendingTemporaryFontDeleteRecord extends TemporaryActiveFontRecord {
  queuedAt: string;
  reason: string;
  attempts: number;
  lastError?: string;
  blockedBySharing?: boolean;
  nextRetryAt?: string;
}

export interface TemporaryFontDeleteQueueEntry {
  ok: boolean;
  message: string;
}

export type TemporaryFontDeleteQueueResult = Record<
  string,
  TemporaryFontDeleteQueueEntry
>;

const SHARING_RETRY_DELAYS_MS = [5_000, 15_000, 60_000, 5 * 60_000, 15 * 60_000] as const;

export function isTemporaryFontSharingViolation(message: unknown): boolean {
  return /\(os error 32\)/i.test(String(message || ""));
}

export function temporaryFontDeleteRetryDelayMs(attempts: number): number {
  const index = Math.min(SHARING_RETRY_DELAYS_MS.length - 1, Math.max(0, Math.trunc(attempts) - 1));
  return SHARING_RETRY_DELAYS_MS[index];
}

export interface TemporaryFontDeleteQueueDeps {
  appName: string;
  dataPath: (name: string) => string;
  dataRoot: () => string;
  currentUserFontsDir: () => string;
  withGlobalIo: <T>(
    label: string,
    task: () => Promise<T>,
    options?: GlobalIoOptions,
  ) => Promise<T>;
  delayToEventLoop: () => Promise<void>;
  appendStartupLog: (message: string) => void;
  flushDelayMs?: number;
  runRustFontActivationFiles?: FontActivationRuntimeDeps['runRustFontActivationFiles'];
}

export function createTemporaryFontDeleteQueue(deps: TemporaryFontDeleteQueueDeps) {
  const flushDelayMs = deps.flushDelayMs ?? 80;
  let deleteTimer: ReturnType<typeof setTimeout> | null = null;
  let deleteInFlight: Promise<void> | null = null;

  function pendingTemporaryFontDeletesPath(): string {
    return deps.dataPath("pending-temporary-font-deletes.json");
  }

  const store = createLocalRecoveryFileRuntime<PendingTemporaryFontDeleteRecord>(pendingTemporaryFontDeletesPath, value => {
    const record = value as PendingTemporaryFontDeleteRecord | undefined;
    return !!record && isTemporaryActiveFontRecord(record) && typeof record.queuedAt === "string"
      && typeof record.reason === "string" && Number.isInteger(record.attempts) && record.attempts >= 0
      && (record.lastError === undefined || typeof record.lastError === "string")
      && (record.blockedBySharing === undefined || typeof record.blockedBySharing === "boolean")
      && (record.nextRetryAt === undefined || typeof record.nextRetryAt === "string");
  });

  const identityRuntime = createManagedActivationIdentityRuntime(deps);
  function isSafeTemporaryActiveFontPath(filePath: string): boolean {
    return safeManagedActivationPath(filePath, deps.currentUserFontsDir(), deps.appName);
  }

  async function queueTemporaryFontFileDeletes(
    records: TemporaryActiveFontRecord[],
    reason: string,
  ): Promise<TemporaryFontDeleteQueueResult> {
    const results: TemporaryFontDeleteQueueResult = {};
    const safeRecords: TemporaryActiveFontRecord[] = [];
    for (const record of records) {
      if (isSafeTemporaryActiveFontPath(record.installPath)) {
        try {
          await identityRuntime.verify(record);
          safeRecords.push({ ...record, stage: 'file-pending' });
        } catch (error) { results[record.installPath] = { ok: false, message: String(error) }; }

        continue;
      }
      const message = "安全保护：临时字体文件不在允许的删除范围内。";
      results[record.installPath] = { ok: false, message };
      deps.appendStartupLog(`skip unsafe temporary font delete queue: ${record.installPath}`);
    }
    if (!safeRecords.length) return results;

    const pending = await store.update(existing => {
      const merged = new Map<string, PendingTemporaryFontDeleteRecord>();
      for (const record of existing) merged.set(record.installPath.toLowerCase(), record);
      for (const record of safeRecords) {
        const key = record.installPath.toLowerCase();
        const old = merged.get(key);
        merged.set(key, {
          ...record,
          queuedAt: old?.queuedAt || new Date().toISOString(),
          reason,
          attempts: old?.attempts || 0,
          lastError: old?.lastError,
          blockedBySharing: old?.blockedBySharing,
          nextRetryAt: old?.nextRetryAt,
        });
      }

      return Array.from(merged.values());
    });
    for (const record of safeRecords) {
      results[record.installPath] = {
        ok: true,
        message: "临时字体文件已进入持久删除队列。",
      };
    }
    deps.appendStartupLog(
      `temporary font async delete queued: reason=${reason}, rows=${safeRecords.length}, pending=${pending.length}`,
    );

    if (deleteTimer) return results;
    deleteTimer = setTimeout(() => {
      deleteTimer = null;
      void flushPendingTemporaryFontDeletes("timer").catch(error => {
        deps.appendStartupLog(`temporary font delete persistence failed: ${String(error)}`);
      });
    }, flushDelayMs);
    return results;
  }

  async function flushPendingTemporaryFontDeletes(reason: string): Promise<void> {
    if (deleteTimer) {
      clearTimeout(deleteTimer);
      deleteTimer = null;
    }
    if (deleteInFlight) {
      await deleteInFlight;
      return;
    }

    let summary = "";
    let nextAutomaticRetryAt = 0;
    deleteInFlight = store.update(async records => {
      const startedAt = Date.now();
      if (!records.length) return records;

      const remaining: PendingTemporaryFontDeleteRecord[] = [];
      let deleted = 0;
      let skippedUnsafe = 0;
      let sharingDeferred = 0;
      const forceRetry = reason === "startup" || reason === "user-retry";

      const safeDeleteRecords: PendingTemporaryFontDeleteRecord[] = [];
      for (const record of records) {
        const retryAt = record.nextRetryAt ? Date.parse(record.nextRetryAt) : 0;
        if (!forceRetry && record.blockedBySharing && Number.isFinite(retryAt) && retryAt > Date.now()) {
          sharingDeferred += 1;
          nextAutomaticRetryAt = nextAutomaticRetryAt ? Math.min(nextAutomaticRetryAt, retryAt) : retryAt;
          remaining.push(record);
          continue;
        }
        if (!isSafeTemporaryActiveFontPath(record.installPath)) {
          skippedUnsafe += 1;
          remaining.push({ ...record, lastError: "安全保护：目标不属于临时字体目录，保留记录待核验。" });
          continue;
        }
        try { await identityRuntime.verify(record); safeDeleteRecords.push(record); }
        catch (error) { remaining.push({ ...record, lastError: String(error) }); }
      }

      const rustResult = await deps.runRustFontActivationFiles?.({
        deletes: safeDeleteRecords.map((record) => record.installPath),
        identities: Object.fromEntries(safeDeleteRecords.filter(record => record.identity).map(record => [record.installPath, record.identity!])),
        allowedDeleteDir: deps.currentUserFontsDir(),
        allowedNamePrefix: `${deps.appName}_ACTIVE_`,
      }).catch((error) => {
        deps.appendStartupLog(`rust temporary font delete route failed: ${error instanceof Error ? error.message : String(error)}`);
        return { deleteResults: safeDeleteRecords.map(record => ({ path: record.installPath, ok: false, message: String(error) })) };
      });

      if (rustResult) {
        const byPath = new Map(rustResult.deleteResults.map((row) => [row.path.toLowerCase(), row]));
        for (const record of safeDeleteRecords) {
          const row = byPath.get(record.installPath.toLowerCase());
          if (row?.ok) {
            deleted += 1;
            continue;
          }
          const attempts = (record.attempts || 0) + 1;
          const message = row?.message || "未收到删除成功回执。";
          if (isTemporaryFontSharingViolation(message)) {
            const delayMs = temporaryFontDeleteRetryDelayMs(attempts);
            const retryAt = Date.now() + delayMs;
            nextAutomaticRetryAt = nextAutomaticRetryAt ? Math.min(nextAutomaticRetryAt, retryAt) : retryAt;
            remaining.push({ ...record, attempts, lastError: message, blockedBySharing: true, nextRetryAt: new Date(retryAt).toISOString() });
            deps.appendStartupLog(`rust temporary font delete deferred by sharing violation: path=${record.installPath}, attempts=${attempts}, retryInMs=${delayMs}`);
          } else {
            remaining.push({ ...record, attempts, lastError: message, blockedBySharing: false, nextRetryAt: undefined });
            deps.appendStartupLog(`rust temporary font async delete failed: path=${record.installPath}, attempts=${attempts}, ${message}`);
          }
        }
      } else if (!nodeBridgeFallbackCompatibilityAllowed()) {
        logNodeBridgeFallbackDisabled({
          appendStartupLog: deps.appendStartupLog,
          source: "activation-delete-async",
          reason: deps.runRustFontActivationFiles ? "rust-activation-delete-missed" : "rust-activation-delete-unavailable",
          detail: `rows=${safeDeleteRecords.length}`,
        });
        for (const record of safeDeleteRecords) {
          const attempts = (record.attempts || 0) + 1;
          remaining.push({ ...record, attempts, lastError: "原生删除不可用，未执行文件删除。", blockedBySharing: false, nextRetryAt: undefined });
        }
      } else {
        logNodeBridgeFallbackUsed({
          appendStartupLog: deps.appendStartupLog,
          source: "activation-delete-async",
          reason: deps.runRustFontActivationFiles ? "rust-activation-delete-missed" : "rust-activation-delete-unavailable",
          detail: `rows=${safeDeleteRecords.length}`,
        });
        for (const record of safeDeleteRecords) {
          try {
            await deps.withGlobalIo(
              "deactivate:remove-font-background",
              () => fsp.rm(record.installPath, { force: true }),
              { priority: "background", storagePath: record.installPath },
            );
            deleted += 1;
          } catch (error) {
            const attempts = (record.attempts || 0) + 1;
            const message = error instanceof Error ? error.message : String(error);
            if (isTemporaryFontSharingViolation(message)) {
              const delayMs = temporaryFontDeleteRetryDelayMs(attempts);
              const retryAt = Date.now() + delayMs;
              nextAutomaticRetryAt = nextAutomaticRetryAt ? Math.min(nextAutomaticRetryAt, retryAt) : retryAt;
              remaining.push({ ...record, attempts, lastError: message, blockedBySharing: true, nextRetryAt: new Date(retryAt).toISOString() });
              deps.appendStartupLog(`temporary font delete deferred by sharing violation: path=${record.installPath}, attempts=${attempts}, retryInMs=${delayMs}`);
            } else {
              remaining.push({ ...record, attempts, lastError: message, blockedBySharing: false, nextRetryAt: undefined });
              deps.appendStartupLog(`temporary font async delete failed: path=${record.installPath}, attempts=${attempts}, ${message}`);
            }
          }
          await deps.delayToEventLoop();
        }
      }

      summary = `temporary font async delete flushed: reason=${reason}, deleted=${deleted}, remaining=${remaining.length}, sharingDeferred=${sharingDeferred}, skippedUnsafe=${skippedUnsafe}, elapsed=${Date.now() - startedAt}ms`;
      return remaining;
    }).then(() => {
      if (summary) deps.appendStartupLog(summary);
      if (nextAutomaticRetryAt > Date.now() && !deleteTimer) {
        const delayMs = Math.max(1_000, nextAutomaticRetryAt - Date.now());
        deleteTimer = setTimeout(() => {
          deleteTimer = null;
          void flushPendingTemporaryFontDeletes("sharing-backoff").catch(error => {
            deps.appendStartupLog(`temporary font sharing-backoff retry failed: ${String(error)}`);
          });
        }, delayMs);
        if (typeof deleteTimer.unref === "function") deleteTimer.unref();
      }
    }).finally(() => {
      deleteInFlight = null;
    });

    await deleteInFlight;
  }

  return {
    loadPendingTemporaryFontDeletes: store.load,
    updatePendingTemporaryFontDeletes: store.update,
    isSafeTemporaryActiveFontPath,
    queueTemporaryFontFileDeletes,
    flushPendingTemporaryFontDeletes,
  };
}
