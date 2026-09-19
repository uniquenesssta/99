import { createFontCleanupRemnantsRuntime } from './runtime/fontCleanupRemnantsRuntime';
import { createFontActivationBatchRuntime } from "./runtime/fontActivationBatchRuntime";
import { createFontActivationCleanupRuntime } from "./runtime/fontActivationCleanupRuntime";
import { createFontActivationCompensationRuntime } from "./runtime/fontActivationCompensationRuntime";
import { createFontActivationCopyRuntime } from "./runtime/fontActivationCopyRuntime";
import { createFontActivationInstallStatusRuntime } from "./runtime/fontActivationInstallStatusRuntime";
import { createFontActivationSessionRuntime } from "./runtime/fontActivationSessionRuntime";
import { createFontActivationTraceRuntime } from "./runtime/fontActivationTraceRuntime";
import { createFontActivationTransactionRuntime } from "./runtime/fontActivationTransactionRuntime";
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
  const transactionRuntime = createFontActivationTransactionRuntime(
    deps,
    traceRuntime,
    verifyRuntime,
    installStatusRuntime,
    copyRuntime,
    compensationRuntime,
  );
  const sessionRuntime = createFontActivationSessionRuntime(
    deps,
    installStatusRuntime,
    cleanupRuntime,
    transactionRuntime,
  );
  const batchRuntime = createFontActivationBatchRuntime(
    deps,
    cleanupRuntime,
    transactionRuntime,
  );

  async function cleanupTemporaryActiveFontsUntilEmpty(
    reason: "startup" | "quit" | "manual" = "manual",
    maxAttempts = 1,
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

  let mutationTail: Promise<unknown> = Promise.resolve();
  function serial<Args extends unknown[], Result>(action: (...args: Args) => Promise<Result>) {
    return (...args: Args): Promise<Result> => {
      const task = mutationTail.catch(() => undefined).then(() => action(...args));
      mutationTail = task;
      return task;
    };
  }
  const remnants = createFontCleanupRemnantsRuntime(deps, cleanupRuntime, async () => {
    await cleanupTemporaryActiveFontsUntilEmpty('manual', 1);
    await cleanupRuntime.flushPendingTemporaryFontDeletes('manual');
  });
  return {
    readFontCleanupRemnants: remnants.readFontCleanupRemnants,
    runFontCleanupAction: serial(remnants.runFontCleanupAction),
    activationTraceStep: traceRuntime.activationTraceStep,
    ...sessionRuntime,
    ...batchRuntime,
    activateFontSession: serial(sessionRuntime.activateFontSession),
    deactivateFontSession: serial(sessionRuntime.deactivateFontSession),
    activateFontSessionsBatch: serial(batchRuntime.activateFontSessionsBatch),
    deactivateFontSessionsBatch: serial(batchRuntime.deactivateFontSessionsBatch),
    cleanupTemporaryActiveFontsUntilEmpty: serial(cleanupTemporaryActiveFontsUntilEmpty),
    flushPendingTemporaryFontDeletes:
      cleanupRuntime.flushPendingTemporaryFontDeletes,
  };
}
