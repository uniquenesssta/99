import { createManagedActivationIdentityRuntime } from './managedActivationIdentityRuntime';
import { createFontActivationTraceRuntime } from "./fontActivationTraceRuntime";
import type { FontItem } from '../../../shared/types';
import { createFontActivationInstallStatusRuntime } from './fontActivationInstallStatusRuntime';
import { promises as fsp } from "node:fs";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import { createTemporaryFontDeleteQueue } from "../temporaryFontDeleteQueue";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";
import type { FontActivationVerifyRuntime } from "./fontActivationVerifyRuntime";
import {
  logNodeBridgeFallbackDisabled,
  logNodeBridgeFallbackUsed,
  nodeBridgeFallbackCompatibilityAllowed,
  nodeBridgeFallbackDeniedMessage,
} from "../../rust-core/nodeBridgeFallbackCompatibilityRuntime";

export function createFontActivationCleanupRuntime(
  deps: FontActivationRuntimeDeps,
  verifyRuntime: FontActivationVerifyRuntime,
) {
  const {
    appName: APP_NAME,
    dataPath,
    dataRoot,
    currentUserFontsDir,
    removeFontResourceSession,
    deleteRegistryValueHKCU,
    advancedFontRefresh,
    clearInstalledFontsMemoryCache,
    saveTemporaryActiveFonts,
    loadTemporaryActiveFonts,
    withGlobalIo,
    delayToEventLoop,
    appendStartupLog,
    runRustFontActivationFiles,
  } = deps;
  const { activationTraceStep } = createFontActivationTraceRuntime(deps);
  const { temporaryActiveRecordStillVisible } = verifyRuntime;
  const identityRuntime = createManagedActivationIdentityRuntime(deps);
  async function persistRecordStages(records: TemporaryActiveFontRecord[], stage: TemporaryActiveFontRecord['stage'], lastError = ''): Promise<void> {
    if (!records.length) return;
    const state = await loadTemporaryActiveFonts();
    const targets = new Map(records.map(record => [record.installPath, record]));
    const matched = new Set<string>();
    const next = state.records.map(current => {
      const target = targets.get(current.installPath);
      if (!target || target.sessionId !== current.sessionId) return current;
      matched.add(current.installPath);
      return { ...current, stage, lastError };
    });
    if (matched.size !== targets.size) throw new Error('激活记录已变化，清理阶段未提交。');
    await saveTemporaryActiveFonts({ version: 1, records: next });
    for (const record of records) { record.stage = stage; record.lastError = lastError; }
  }
  async function persistRecordStage(record: TemporaryActiveFontRecord, stage: TemporaryActiveFontRecord['stage'], lastError = ''): Promise<void> {
    await persistRecordStages([record], stage, lastError);
  }

  const temporaryFontDeleteQueue = createTemporaryFontDeleteQueue({
    appName: APP_NAME,
    dataPath,
    dataRoot,
    currentUserFontsDir,
    withGlobalIo,
    delayToEventLoop,
    appendStartupLog,
    flushDelayMs: 80,
    runRustFontActivationFiles,
  });

  const {
    isSafeTemporaryActiveFontPath,
    queueTemporaryFontFileDeletes,
    flushPendingTemporaryFontDeletes,
  } = temporaryFontDeleteQueue;

  async function removeTemporaryActiveRecord(
    record: TemporaryActiveFontRecord,
    options: {
      verifyVisibility?: boolean;
      deleteFileMode?: "inline" | "background";
    } = {},
  ): Promise<boolean> {
    let fileRemoved = true;
    await identityRuntime.verify(record);
    if (record.stage !== 'registry-removal-pending' && record.stage !== 'file-pending') {
      await persistRecordStage(record, 'resource-removal-pending');
      await activationTraceStep("deactivate:resource-remove", record.fontId, () => removeFontResourceSession(record.installPath));
      await persistRecordStage(record, 'registry-removal-pending');
    }
    if (record.stage !== 'file-pending') {
      await activationTraceStep("deactivate:registry-settlement", record.fontId, () => deleteRegistryValueHKCU(record.registryName));
      await persistRecordStage(record, 'file-pending');
    }

    if (options.deleteFileMode === "background") {
      const queueResult = await activationTraceStep("deactivate:file-queue", record.fontId, () => queueTemporaryFontFileDeletes([record], "deactivate"));
      const queued = queueResult[record.installPath];
      if (!queued?.ok) {
        appendStartupLog(
          `temporary font file queue rejected: ${record.installPath} ${queued?.message || "missing queue result"}`,
        );
        return false;
      }
    } else {
      try {
        if (!isSafeTemporaryActiveFontPath(record.installPath)) {
          appendStartupLog(
            `skip unsafe temporary font delete: ${record.installPath}`,
          );
          return false;
        }

        const rustDelete = await runRustFontActivationFiles?.({
          deletes: [record.installPath],
          identities: record.identity ? { [record.installPath]: record.identity } : {},
          allowedDeleteDir: currentUserFontsDir(),
          allowedNamePrefix: `${APP_NAME}_ACTIVE_`,
        }).catch((error) => {
          appendStartupLog(`rust temporary font inline delete route failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        });
        if (rustDelete) {
          const row = rustDelete.deleteResults[0];
          if (!row?.ok) throw new Error(row?.message || 'Rust temporary font delete failed');
        } else {
          if (!nodeBridgeFallbackCompatibilityAllowed()) {
            logNodeBridgeFallbackDisabled({
              appendStartupLog,
              source: "activation-delete-inline",
              reason: runRustFontActivationFiles ? "rust-activation-delete-missed" : "rust-activation-delete-unavailable",
              detail: `path=${record.installPath}`,
            });
            throw new Error(nodeBridgeFallbackDeniedMessage("activation-delete-inline"));
          }
          logNodeBridgeFallbackUsed({
            appendStartupLog,
            source: "activation-delete-inline",
            reason: runRustFontActivationFiles ? "rust-activation-delete-missed" : "rust-activation-delete-unavailable",
            detail: `path=${record.installPath}`,
          });
          await fsp.unlink(record.installPath);
        }
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? String((error as NodeJS.ErrnoException).code)
            : "";
        if (code !== "ENOENT") {
          fileRemoved = false;
          appendStartupLog(
            `temporary font file delete failed: ${record.installPath} ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    if (
      options.verifyVisibility !== false &&
      (await temporaryActiveRecordStillVisible(record))
    ) {
      appendStartupLog(
        `temporary active record still visible after remove: ${record.installPath}`,
      );
      return false;
    }

    return fileRemoved;
  }

  async function cleanupTemporaryActiveFonts(
    reason: "startup" | "quit" | "manual" = "manual",
  ): Promise<{ cleaned: number; remaining: number }> {
    if (process.platform !== "win32") return { cleaned: 0, remaining: 0 };

    const state = await loadTemporaryActiveFonts();
    if (!state.records.length) return { cleaned: 0, remaining: 0 };

    appendStartupLog(
      `temporary active fonts cleanup started: ${reason}, count=${state.records.length}`,
    );

    const remaining: TemporaryActiveFontRecord[] = [];
    let cleaned = 0;

    for (const record of state.records) {
      let ok = false;
      try { ok = await removeTemporaryActiveRecord(record, { deleteFileMode: 'background' }); }
      catch (error) {
        record.lastError = error instanceof Error ? error.message : String(error);
        appendStartupLog(`temporary font cleanup retained: ${record.installPath}, ${record.lastError}`);
      }
      if (ok) {
        cleaned += 1;
      } else {
        remaining.push(record);
      }
    }

    await saveTemporaryActiveFonts({ version: 1, records: remaining });
    clearInstalledFontsMemoryCache();
    const removed = state.records.filter(record => !remaining.includes(record));
    if (removed.length) {
      try {
        await createFontActivationInstallStatusRuntime(deps).reconcileDeactivatedInstallStatus(
          removed.map(record => ({ id: record.fontId, path: record.sourcePath, fileName: record.fileName,
            managedInstallPath: record.installPath } as FontItem)), removed.map(record => record.installPath));
      } catch (error) {
        appendStartupLog(`temporary cleanup status reconciliation failed: ${String(error)}`);
      }
    }

    appendStartupLog(
      `temporary active fonts cleanup finished: ${reason}, cleaned=${cleaned}, remaining=${remaining.length}`,
    );
    if (cleaned > 0) {
      await advancedFontRefresh(`cleanup-${reason}`);
    }
    return { cleaned, remaining: remaining.length };
  }

  async function cleanupTemporaryActiveFontsUntilEmpty(
    reason: "startup" | "quit" | "manual" = "manual",
    maxAttempts = 1,
  ): Promise<{ cleaned: number; remaining: number }> {
    let totalCleaned = 0;
    let remaining = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await cleanupTemporaryActiveFonts(reason);
      totalCleaned += result.cleaned;
      remaining = result.remaining;

      if (!remaining) return { cleaned: totalCleaned, remaining: 0 };

      appendStartupLog(
        `temporary active cleanup retry pending: reason=${reason}, attempt=${attempt}, remaining=${remaining}`,
      );
      await new Promise((resolveRetry) =>
        setTimeout(resolveRetry, Math.min(1800, 500 + attempt * 120)),
      );
    }

    return { cleaned: totalCleaned, remaining };
  }

  return {
    loadPendingTemporaryFontDeletes: temporaryFontDeleteQueue.loadPendingTemporaryFontDeletes,
    updatePendingTemporaryFontDeletes: temporaryFontDeleteQueue.updatePendingTemporaryFontDeletes,
    isSafeTemporaryActiveFontPath,
    queueTemporaryFontFileDeletes,
    flushPendingTemporaryFontDeletes,
    persistRecordStage,
    persistRecordStages,
    verifyManagedRecord: identityRuntime.verify,
    removeTemporaryActiveRecord,
    cleanupTemporaryActiveFonts,
    cleanupTemporaryActiveFontsUntilEmpty,
  };
}

export type FontActivationCleanupRuntime = ReturnType<typeof createFontActivationCleanupRuntime>;
