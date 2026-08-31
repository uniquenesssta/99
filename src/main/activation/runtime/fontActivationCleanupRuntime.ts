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
  const { temporaryActiveRecordStillVisible } = verifyRuntime;

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

    await removeFontResourceSession(record.installPath);
    await deleteRegistryValueHKCU(record.registryName);

    if (options.deleteFileMode === "background") {
      await queueTemporaryFontFileDeletes([record], "deactivate");
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
          allowedDeleteDir: currentUserFontsDir(),
          allowedNamePrefix: `${APP_NAME}_ACTIVE_`,
        }).catch((error) => {
          appendStartupLog(`rust temporary font inline delete route failed: ${error instanceof Error ? error.message : String(error)}`);
          return null;
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
      const ok = await removeTemporaryActiveRecord(record);
      if (ok) {
        cleaned += 1;
      } else {
        remaining.push(record);
      }
    }

    await saveTemporaryActiveFonts({ version: 1, records: remaining });
    clearInstalledFontsMemoryCache();

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
    maxAttempts = 18,
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
    isSafeTemporaryActiveFontPath,
    queueTemporaryFontFileDeletes,
    flushPendingTemporaryFontDeletes,
    removeTemporaryActiveRecord,
    cleanupTemporaryActiveFonts,
    cleanupTemporaryActiveFontsUntilEmpty,
  };
}

export type FontActivationCleanupRuntime = ReturnType<typeof createFontActivationCleanupRuntime>;
