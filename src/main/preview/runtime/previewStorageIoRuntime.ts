import { previewCacheQueryTimeoutMs, withIoDeadlineResult } from "../../path/ioDeadlineRuntime";
import type { PreviewCacheStorage, PreviewRuntimeOptions } from "./previewRuntimeTypes";
import type { createPreviewCacheRootAvailabilityRuntime } from "./previewCacheRootAvailabilityRuntime";

export function createPreviewStorageIoRuntime(
  options: Pick<PreviewRuntimeOptions, "appendStartupLog">,
  rootAvailability: Pick<ReturnType<typeof createPreviewCacheRootAvailabilityRuntime>, "markRootPreviewCacheUnavailable">,
) {
  const previewCacheIoTimeoutMs = previewCacheQueryTimeoutMs();
  function rustPreviewDbPathForStorage(
    storage: PreviewCacheStorage,
  ): string | null {
    // Local preview DB can stay open in the main process; keep it on Node to avoid cross-process SQLite lock churn.
    return storage.storage === "local" ? null : storage.indexDbPath || null;
  }

  function previewCacheIoErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function runRequiredRootPreviewCacheIo<T>(
    rootPath: string,
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = await withIoDeadlineResult(
      label,
      operation,
      previewCacheIoTimeoutMs,
    );
    if (!result.ok) {
      rootAvailability.markRootPreviewCacheUnavailable(rootPath, result.error);
      throw result.error;
    }
    return result.value;
  }

  async function runOptionalRootPreviewCacheIo<T>(
    rootPath: string,
    label: string,
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const result = await withIoDeadlineResult(
      label,
      operation,
      previewCacheIoTimeoutMs,
    );
    if (!result.ok) {
      rootAvailability.markRootPreviewCacheUnavailable(rootPath, result.error);
      options.appendStartupLog(
        `preview cache io deadline dropped: ${label}, ${previewCacheIoErrorMessage(result.error)}`,
      );
      return { ok: false };
    }
    return { ok: true, value: result.value };
  }

  async function runStoragePreviewCacheIo<T>(
    storage: PreviewCacheStorage,
    label: string,
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (storage.storage === "root" && storage.rootPath)
      return runOptionalRootPreviewCacheIo(storage.rootPath, label, operation);
    return { ok: true, value: await operation() };
  }

  return { rustPreviewDbPathForStorage, runRequiredRootPreviewCacheIo, runStoragePreviewCacheIo };
}
