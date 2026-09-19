import { assertLocalShutdownWorkAllowed } from '../../app/shutdownCoordinatorRuntime';
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";

export function createFontActivationTraceRuntime(deps: Pick<FontActivationRuntimeDeps, "appendStartupLog">) {
  const appendStartupLog = (message: string): void => {
    try { deps.appendStartupLog(message); } catch { /* Logging cannot change a committed operation. */ }
  };

  async function activationTraceStep<T>(
    label: string,
    fontId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      assertLocalShutdownWorkAllowed();
      const result = await fn();
      appendStartupLog(
        `activation step: ${label}, fontId=${fontId || "unknown"}, elapsed=${Date.now() - startedAt}ms`,
      );
      return result;
    } catch (error) {
      appendStartupLog(
        `activation step failed: ${label}, fontId=${fontId || "unknown"}, elapsed=${Date.now() - startedAt}ms, ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  function activationTraceSync<T>(
    label: string,
    fontId: string | undefined,
    fn: () => T,
  ): T {
    const startedAt = Date.now();
    try {
      const result = fn();
      appendStartupLog(
        `activation step: ${label}, fontId=${fontId || "unknown"}, elapsed=${Date.now() - startedAt}ms`,
      );
      return result;
    } catch (error) {
      appendStartupLog(
        `activation step failed: ${label}, fontId=${fontId || "unknown"}, elapsed=${Date.now() - startedAt}ms, ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  return { activationTraceStep, activationTraceSync };
}

export type FontActivationTraceRuntime = ReturnType<typeof createFontActivationTraceRuntime>;
