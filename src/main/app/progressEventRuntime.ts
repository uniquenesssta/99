import type {
FontIndexProgressPayload,
InstallStatusProgressPayload,
} from "../../shared/types";

type ProgressEventRuntimeOptions = {
  indexProgressMinIntervalMs: number;
  sendToRendererWindows: (channel: string, payload: unknown) => void;
};

export type ProgressEventRuntime = {
  createFontScanJobId: () => string;
  emitFontIndexProgress: (payload: FontIndexProgressPayload) => void;
  createInstallStatusRefreshJobId: () => string;
  emitInstallStatusProgress: (
    payload: Omit<InstallStatusProgressPayload, "at"> & { at?: string },
  ) => void;
  createFontIndexProgressReporter: (
    jobId: string,
    folders: string[],
  ) => (
    payload: Omit<FontIndexProgressPayload, "jobId" | "folders" | "at">,
    force?: boolean,
  ) => void;
};

function createRuntimeJobId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createProgressEventRuntime(
  options: ProgressEventRuntimeOptions,
): ProgressEventRuntime {
  function emitFontIndexProgress(payload: FontIndexProgressPayload): void {
    options.sendToRendererWindows("font-index:progress", payload);
  }

  function emitInstallStatusProgress(
    payload: Omit<InstallStatusProgressPayload, "at"> & { at?: string },
  ): void {
    const message: InstallStatusProgressPayload = {
      ...payload,
      at: payload.at || new Date().toISOString(),
    };
    options.sendToRendererWindows("install-status:progress", message);
  }

  function createFontIndexProgressReporter(
    jobId: string,
    folders: string[],
  ): (
    payload: Omit<FontIndexProgressPayload, "jobId" | "folders" | "at">,
    force?: boolean,
  ) => void {
    let lastSentAt = 0;
    return (payload, force = false) => {
      const now = Date.now();
      if (!force && now - lastSentAt < options.indexProgressMinIntervalMs)
        return;
      lastSentAt = now;
      emitFontIndexProgress({
        ...payload,
        jobId,
        folders,
        at: new Date(now).toISOString(),
      });
    };
  }

  return {
    createFontScanJobId: () => createRuntimeJobId("index"),
    emitFontIndexProgress,
    createInstallStatusRefreshJobId: () => createRuntimeJobId("install-status"),
    emitInstallStatusProgress,
    createFontIndexProgressReporter,
  };
}
