import { BrowserWindow } from "electron";
import fs, { promises as fsp } from "node:fs";
import { resolve } from "node:path";
import type { FontIndexChangePayload } from "../../shared/types";
import { normalizePathForCacheCompare } from "../path/cachePath";
import { ensureStartupPathRootAvailable } from "../path/startupPathAvailabilityRuntime";

export interface PendingFolderChange {
  folder: string;
  eventType: string;
  fileName: string;
  receivedAt: number;
}

interface FolderWatcherRuntimeOptions {
  appendStartupLog: (message: string) => void;
  isIgnoredWatcherPath: (fileName?: string) => boolean;
  verboseLogs: boolean;
  startupGraceMs: number;
  flushDebounceMs: number;
  closeRuntimeDatabases: () => void;
  watcherChangeBatchLooksUnchanged: (
    rootPath: string,
    changes: PendingFolderChange[],
  ) => Promise<boolean>;
  applyWatchedFolderChangesToIndex: (
    changes: PendingFolderChange[],
  ) => Promise<FontIndexChangePayload>;
  syncMergedIndexForRootIncremental?: (
    rootPath: string,
    payload: FontIndexChangePayload,
    reason: string,
  ) => Promise<void>;
  syncMergedIndexForRootSnapshot?: (rootPath: string, reason: string) => Promise<void>;
  isScanActive?: () => boolean;
}

export interface FolderWatcherRuntime {
  stopFolderWatchers: () => void;
  sendFontIndexChanged: (payload: FontIndexChangePayload) => void;
  flushPendingFolderChanges: () => Promise<void>;
  notifyFolderChanged: (
    folder: string,
    eventType: string,
    fileName?: string,
  ) => void;
  startWatchingFolders: (folders: string[]) => Promise<boolean>;
}

export function createFolderWatcherRuntime(
  options: FolderWatcherRuntimeOptions,
): FolderWatcherRuntime {
  let folderWatchers: fs.FSWatcher[] = [];
  let folderWatchTimer: ReturnType<typeof setTimeout> | null = null;
  let currentFolderWatchSignature = "";
  let folderWatchersHealthy = false;
  let folderWatcherIgnoreUntil = 0;
  const pendingFolderChanges = new Map<string, PendingFolderChange>();
  const recoveryBatches = new Map<string, PendingFolderChange[]>();
  let delayedDuringScanLoggedAt = 0;
  let watcherGeneration = 0;
  let flushInFlight: Promise<void> | null = null;
  let flushRequested = false;

  function stopFolderWatchers(): void {
    watcherGeneration += 1;
    folderWatchersHealthy = false;
    flushRequested = false;
    for (const watcher of folderWatchers) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }

    folderWatchers = [];
    currentFolderWatchSignature = "";
    pendingFolderChanges.clear();
    recoveryBatches.clear();

    if (folderWatchTimer) {
      clearTimeout(folderWatchTimer);
      folderWatchTimer = null;
    }
  }

  function sendFontIndexChanged(payload: FontIndexChangePayload): void {
    if (
      !payload.upserts.length &&
      !payload.deletes.length &&
      !payload.errors?.length
    )
      return;

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("font-index:changed", payload);
      }
    }
  }

  function queueRecovery(rootPath: string, changes: PendingFolderChange[], payload?: FontIndexChangePayload): void {
    const key = normalizePathForCacheCompare(rootPath);
    if (!currentFolderWatchSignature.split("\n").includes(key)) return;
    // Re-read current files; never replay a failed resource operation or old mutation payload.
    const retries = [...(recoveryBatches.get(key) || []), ...changes,
      ...(payload?.deletes || []).map((item) => ({ folder: rootPath, fileName: item.relativePath, eventType: "rescan", receivedAt: Date.now() }))];
    recoveryBatches.set(key, Array.from(new Map(retries.map((item) => [item.fileName, { ...item, eventType: "rescan" }])).values()));
    schedulePendingFolderFlush(Math.max(options.flushDebounceMs, folderWatcherIgnoreUntil - Date.now()));
  }

  async function flushPendingFolderChangesPass(
    generation: number,
  ): Promise<void> {
    const changes = Array.from(pendingFolderChanges.values());
    pendingFolderChanges.clear();
    const recovering = Array.from(recoveryBatches.values());
    recoveryBatches.clear();
    if ((!changes.length && !recovering.length) || generation !== watcherGeneration) return;

    const grouped = new Map<string, PendingFolderChange[]>();
    for (const change of changes) {
      const key = normalizePathForCacheCompare(resolve(change.folder));
      const items = grouped.get(key) || [];
      items.push(change);
      grouped.set(key, items);
    }

    const jobs = [...recovering.map((group) => ({ group, recovery: true })),
      ...Array.from(grouped.values(), (group) => ({ group, recovery: false }))];
    for (const { group, recovery } of jobs) {
      if (generation !== watcherGeneration) return;
      const rootPath = resolve(group[0]?.folder || "");
      let payload: FontIndexChangePayload | undefined;
      try {
        if (!recovery && await options.watcherChangeBatchLooksUnchanged(rootPath, group)) {
          if (generation !== watcherGeneration) return;
          if (options.verboseLogs)
            options.appendStartupLog(
              `font index watcher batch skipped unchanged: ${rootPath}, events=${group.length}`,
            );
          continue;
        }

        if (generation !== watcherGeneration) return;
        payload = await options.applyWatchedFolderChangesToIndex(group);
        if (generation !== watcherGeneration) {
          options.appendStartupLog(
            `font index watcher batch result discarded after watcher restart: ${rootPath}, events=${group.length}`,
          );
          queueRecovery(rootPath, group, payload);
          return;
        }
        if (recovery && options.syncMergedIndexForRootSnapshot) {
          await options.syncMergedIndexForRootSnapshot(rootPath, `watcher-recovery:${rootPath}`);
        } else if ((payload.upserts.length || payload.deletes.length) && options.syncMergedIndexForRootIncremental) {
          await options.syncMergedIndexForRootIncremental(rootPath, payload, `watcher:${rootPath}`);
        }
        if (generation !== watcherGeneration) {
          options.appendStartupLog(
            `font index watcher notification discarded after watcher restart: ${rootPath}, events=${group.length}`,
          );
          queueRecovery(rootPath, group, payload);
          return;
        }
        options.appendStartupLog(
          `font index watcher batch applied: ${rootPath}, events=${group.length}, upserts=${payload.upserts.length}, deletes=${payload.deletes.length}, errors=${payload.errors?.length || 0}`,
        );
        sendFontIndexChanged(payload);
        if (payload.errors?.length) {
          if (!recovery) queueRecovery(rootPath, group, payload);
          else options.appendStartupLog(`folder watcher recovery exhausted: ${rootPath}; use manual refresh after resolving errors`);
        }
      } catch (error) {
        const hints = error && typeof error === "object" ? (error as { watcherRecoveryChanges?: PendingFolderChange[] }).watcherRecoveryChanges : undefined;
        if (!recovery) queueRecovery(rootPath, [...group, ...(hints || [])], payload);
        else options.appendStartupLog(`folder watcher recovery exhausted: ${rootPath}; use manual refresh after resolving errors`);
        options.appendStartupLog(
          `font index watcher batch failed: ${rootPath}, events=${group.length}, ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async function flushPendingFolderChanges(): Promise<void> {
    if (flushInFlight) {
      flushRequested = true;
      await flushInFlight;
      if ((pendingFolderChanges.size > 0 || recoveryBatches.size > 0) && !flushInFlight) {
        schedulePendingFolderFlush(options.flushDebounceMs);
      }
      return;
    }

    const generation = watcherGeneration;
    const task = flushPendingFolderChangesPass(generation);
    flushInFlight = task;
    try {
      await task;
    } finally {
      if (flushInFlight === task) flushInFlight = null;
      const shouldScheduleAgain =
        generation === watcherGeneration &&
        (flushRequested || pendingFolderChanges.size > 0 || recoveryBatches.size > 0);
      flushRequested = false;
      if (shouldScheduleAgain) {
        schedulePendingFolderFlush(options.flushDebounceMs);
      }
    }
  }

  function schedulePendingFolderFlush(delayMs: number): void {
    if (folderWatchTimer) {
      clearTimeout(folderWatchTimer);
      folderWatchTimer = null;
    }

    folderWatchTimer = setTimeout(() => {
      folderWatchTimer = null;
      if (options.isScanActive?.()) {
        const now = Date.now();
        if (now - delayedDuringScanLoggedAt > 10000) {
          delayedDuringScanLoggedAt = now;
          options.appendStartupLog(
            `folder watcher flush delayed during active scan: pending=${pendingFolderChanges.size}`,
          );
        }
        schedulePendingFolderFlush(Math.max(options.flushDebounceMs, 2500));
        return;
      }
      void flushPendingFolderChanges();
    }, delayMs);

    folderWatchTimer.unref?.();
  }

  function notifyFolderChanged(
    folder: string,
    eventType: string,
    fileName?: string,
  ): void {
    if (options.isIgnoredWatcherPath(fileName)) return;

    if (Date.now() < folderWatcherIgnoreUntil) {
      if (options.verboseLogs)
        options.appendStartupLog(
          `folder watcher initial event deferred by grace window: ${folder} ${eventType} ${fileName || ""}`,
        );
    }

    const normalizedFileName = String(fileName || "");
    const changeFileName = normalizedFileName || ".";
    const changeEventType = normalizedFileName ? eventType : "rescan";
    if (!normalizedFileName) {
      options.appendStartupLog(
        `folder watcher event without file name queued for root diff: ${folder} ${eventType}`,
      );
    }

    const key = `${normalizePathForCacheCompare(folder)}\0${changeFileName.toLowerCase()}\0${changeEventType}`;
    pendingFolderChanges.set(key, {
      folder,
      eventType: changeEventType,
      fileName: changeFileName,
      receivedAt: Date.now(),
    });

    schedulePendingFolderFlush(Math.max(options.flushDebounceMs, folderWatcherIgnoreUntil - Date.now()));
  }

  async function startWatchingFolders(folders: string[]): Promise<boolean> {
    const uniqueFolders = Array.from(
      new Set((folders || []).filter(Boolean).map((folder) => resolve(folder))),
    );
    const nextSignature = uniqueFolders
      .map((folder) => normalizePathForCacheCompare(folder))
      .sort()
      .join("\n");

    if (nextSignature === currentFolderWatchSignature && folderWatchersHealthy) {
      if (options.verboseLogs)
        options.appendStartupLog(
          `folder watcher unchanged: ${uniqueFolders.length} folders`,
        );
      return true;
    }

    stopFolderWatchers();
    options.closeRuntimeDatabases();
    const generation = watcherGeneration;

    if (!uniqueFolders.length) {
      folderWatchersHealthy = true;
      options.appendStartupLog("folder watch disabled: no folders");
      return true;
    }

    currentFolderWatchSignature = nextSignature;
    folderWatcherIgnoreUntil = Date.now() + options.startupGraceMs;

    for (const folder of uniqueFolders) {
      try {
        const rootAvailable = await ensureStartupPathRootAvailable(
          folder,
          options.appendStartupLog,
          "folder-watcher-start",
        );
        if (generation !== watcherGeneration) return true;
        if (!rootAvailable) {
          options.appendStartupLog(
            `folder watcher skipped unavailable root: ${folder}`,
          );
          continue;
        }
        const stat = await fsp.stat(folder);
        if (generation !== watcherGeneration) return true;
        if (!stat.isDirectory()) continue;

        let listening = true;
        const watcher = fs.watch(
          folder,
          { recursive: process.platform === "win32" },
          (eventType, fileName) => {
            if (generation !== watcherGeneration || !listening) return;
            notifyFolderChanged(
              folder,
              eventType,
              typeof fileName === "string" ? fileName : String(fileName || ""),
            );
          },
        );

        if (generation !== watcherGeneration) {
          listening = false;
          watcher.close();
          return true;
        }

        watcher.on("error", (error) => {
          if (generation !== watcherGeneration || !listening) return;
          listening = false;
          folderWatchersHealthy = false;
          folderWatchers = folderWatchers.filter((item) => item !== watcher);
          try {
            watcher.close();
          } catch {
            // The failed handle may already be closed.
          }
          options.appendStartupLog(
            `folder watcher error: ${folder} ${error instanceof Error ? error.message : String(error)}`,
          );
        });

        folderWatchers.push(watcher);
        options.appendStartupLog(
          `folder watcher started: ${folder}; initial events deferred for ${options.startupGraceMs}ms`,
        );
      } catch (error) {
        if (generation !== watcherGeneration) return true;
        options.appendStartupLog(
          `folder watcher skipped: ${folder} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (generation === watcherGeneration) {
      folderWatchersHealthy = folderWatchers.length === uniqueFolders.length;
    }
    return true;
  }

  return {
    stopFolderWatchers,
    sendFontIndexChanged,
    flushPendingFolderChanges,
    notifyFolderChanged,
    startWatchingFolders,
  };
}
