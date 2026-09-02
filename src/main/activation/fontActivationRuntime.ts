import { createFontActivationBatchRuntime } from "./runtime/fontActivationBatchRuntime";
import { createFontActivationCleanupRuntime } from "./runtime/fontActivationCleanupRuntime";
import { createFontActivationCompensationRuntime } from "./runtime/fontActivationCompensationRuntime";
import { createFontActivationCopyRuntime } from "./runtime/fontActivationCopyRuntime";
import { createFontActivationInstallStatusRuntime } from "./runtime/fontActivationInstallStatusRuntime";
import { createFontActivationSessionRuntime } from "./runtime/fontActivationSessionRuntime";
import { createFontActivationTraceRuntime } from "./runtime/fontActivationTraceRuntime";
import type { FontActivationRuntimeDeps } from "./runtime/fontActivationTypes";
import { createFontActivationVerifyRuntime } from "./runtime/fontActivationVerifyRuntime";

export type {
ActivationInstallStatusSnapshotResult,
FontActivationRuntimeDeps
} from "./runtime/fontActivationTypes";

export function createFontActivationRuntime(deps: FontActivationRuntimeDeps) {
  const { appendStartupLog } = deps;
  const traceRuntime = createFontActivationTraceRuntime(deps);
  const verifyRuntime = createFontActivationVerifyRuntime(deps);
  const installStatusRuntime = createFontActivationInstallStatusRuntime(deps);
  const cleanupRuntime = createFontActivationCleanupRuntime(
    deps,
    verifyRuntime,
  );
  const copyRuntime = createFontActivationCopyRuntime(deps);
  const compensationRuntime = createFontActivationCompensationRuntime(
    deps,
    cleanupRuntime,
  );
  const sessionRuntime = createFontActivationSessionRuntime(
    deps,
    traceRuntime,
    verifyRuntime,
    installStatusRuntime,
    cleanupRuntime,
    copyRuntime,
    compensationRuntime,
  );
  const batchRuntime = createFontActivationBatchRuntime(
    deps,
    traceRuntime,
    installStatusRuntime,
    cleanupRuntime,
    copyRuntime,
  );

  async function cleanupTemporaryActiveFontsUntilEmpty(
    reason: "startup" | "quit" | "manual" = "manual",
    maxAttempts = 18,
  ): Promise<{ cleaned: number; remaining: number }> {
    let pending = { cleaned: 0, remaining: 0 };
    try {
      pending =
        await compensationRuntime.cleanupPendingFontActivationCompensationsUntilEmpty(
          reason,
          maxAttempts,
        );
    } catch (error) {
      pending.remaining = 1;
      appendStartupLog(
        `pending font activation compensation unavailable: reason=${reason}, ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const active = await cleanupRuntime.cleanupTemporaryActiveFontsUntilEmpty(
      reason,
      maxAttempts,
    );
    return {
      cleaned: pending.cleaned + active.cleaned,
      remaining: pending.remaining + active.remaining,
    };
  }

  return {
    activationTraceStep: traceRuntime.activationTraceStep,
    ...sessionRuntime,
    ...batchRuntime,
    cleanupTemporaryActiveFontsUntilEmpty,
    flushPendingTemporaryFontDeletes:
      cleanupRuntime.flushPendingTemporaryFontDeletes,
  };
}
