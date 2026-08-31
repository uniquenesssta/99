import { createFontActivationBatchRuntime } from "./runtime/fontActivationBatchRuntime";
import { createFontActivationCleanupRuntime } from "./runtime/fontActivationCleanupRuntime";
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
  const traceRuntime = createFontActivationTraceRuntime(deps);
  const verifyRuntime = createFontActivationVerifyRuntime(deps);
  const installStatusRuntime = createFontActivationInstallStatusRuntime(deps);
  const cleanupRuntime = createFontActivationCleanupRuntime(
    deps,
    verifyRuntime,
  );
  const copyRuntime = createFontActivationCopyRuntime(deps);
  const sessionRuntime = createFontActivationSessionRuntime(
    deps,
    traceRuntime,
    verifyRuntime,
    installStatusRuntime,
    cleanupRuntime,
    copyRuntime,
  );
  const batchRuntime = createFontActivationBatchRuntime(
    deps,
    traceRuntime,
    installStatusRuntime,
    cleanupRuntime,
    copyRuntime,
  );

  return {
    activationTraceStep: traceRuntime.activationTraceStep,
    ...sessionRuntime,
    ...batchRuntime,
    cleanupTemporaryActiveFontsUntilEmpty:
      cleanupRuntime.cleanupTemporaryActiveFontsUntilEmpty,
    flushPendingTemporaryFontDeletes:
      cleanupRuntime.flushPendingTemporaryFontDeletes,
  };
}
