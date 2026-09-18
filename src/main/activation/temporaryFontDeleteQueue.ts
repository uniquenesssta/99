import { createLocalRecoveryFileRuntime, isTemporaryActiveFontRecord } from "./runtime/localRecoveryFileRuntime";
import { promises as fsp } from "node:fs";
import { posix, win32 } from "node:path";
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
}

export interface TemporaryFontDeleteQueueEntry {
  ok: boolean;
  message: string;
}

export type TemporaryFontDeleteQueueResult = Record<
  string,
  TemporaryFontDeleteQueueEntry
>;

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
  runRustFontActivationFiles?: (input: { deletes?: string[]; allowedDeleteDir?: string; allowedNamePrefix?: string }) => Promise<{ deleted: number; failed: number; deleteResults: Array<{ path: string; ok: boolean; message: string }> } | null>;
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
      && (record.lastError === undefined || typeof record.lastError === "string");
  });

  function isSafeTemporaryActiveFontPath(filePath: string): boolean {
    const syntax = /^(?:[a-z]:[\\/]|[\\/]{2})/i.test(filePath) ? win32 : posix;
    const target = syntax.resolve(filePath), allowed = syntax.resolve(deps.currentUserFontsDir());
    const normalize = (value: string) => syntax === win32 ? value.toLowerCase() : value;
    return normalize(syntax.dirname(target)) === normalize(allowed)
      && syntax.basename(target).startsWith(`${deps.appName}_ACTIVE_`);
  }

  async function queueTemporaryFontFileDeletes(
    records: TemporaryActiveFontRecord[],
    reason: string,
  ): Promise<TemporaryFontDeleteQueueResult> {
    const results: TemporaryFontDeleteQueueResult = {};
    const safeRecords: TemporaryActiveFontRecord[] = [];
    for (const record of records) {
      if (isSafeTemporaryActiveFontPath(record.installPath)) {
        safeRecords.push({ ...record });
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
    deleteInFlight = store.update(async records => {
      const startedAt = Date.now();
      if (!records.length) return records;

      const remaining: PendingTemporaryFontDeleteRecord[] = [];
      let deleted = 0;
      let skippedUnsafe = 0;

      const safeDeleteRecords: PendingTemporaryFontDeleteRecord[] = [];
      for (const record of records) {
        if (!isSafeTemporaryActiveFontPath(record.installPath)) {
          skippedUnsafe += 1;
          remaining.push({ ...record, lastError: "安全保护：目标不属于临时字体目录，保留记录待核验。" });
          continue;
        }
        safeDeleteRecords.push(record);
      }

      const rustResult = await deps.runRustFontActivationFiles?.({
        deletes: safeDeleteRecords.map((record) => record.installPath),
        allowedDeleteDir: deps.currentUserFontsDir(),
        allowedNamePrefix: `${deps.appName}_ACTIVE_`,
      }).catch((error) => {
        deps.appendStartupLog(`rust temporary font delete route failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
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
          remaining.push({ ...record, attempts, lastError: row?.message || "未收到删除成功回执。" });
          deps.appendStartupLog(`rust temporary font async delete failed: path=${record.installPath}, attempts=${attempts}, ${row?.message || 'unknown error'}`);
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
          remaining.push({ ...record, attempts, lastError: "原生删除不可用，未执行文件删除。" });
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
            remaining.push({ ...record, attempts, lastError: error instanceof Error ? error.message : String(error) });
            deps.appendStartupLog(
              `temporary font async delete failed: path=${record.installPath}, attempts=${attempts}, ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await deps.delayToEventLoop();
        }
      }

      summary = `temporary font async delete flushed: reason=${reason}, deleted=${deleted}, remaining=${remaining.length}, skippedUnsafe=${skippedUnsafe}, elapsed=${Date.now() - startedAt}ms`;
      return remaining;
    }).then(() => { if (summary) deps.appendStartupLog(summary); }).finally(() => {
      deleteInFlight = null;
    });

    await deleteInFlight;
  }

  return {
    isSafeTemporaryActiveFontPath,
    queueTemporaryFontFileDeletes,
    flushPendingTemporaryFontDeletes,
  };
}
