import { withOperationWork } from '../logging/operationTraceContext'
import { isApplicationClosing, onApplicationResumed } from '../app/shutdownCoordinatorRuntime';
import { BrowserWindow } from "electron";
import fs from 'node:fs'
import { sharedIoResourceKeys } from '../rust-core/rustSharedIoCommandRuntime'
import { executeSharedFile, sharedFileSystem as fsp, withSharedIoSignal } from '../path/sharedFileSystemRuntime'
import { resolve } from "node:path";
import type { FontIndexChangePayload } from "../../shared/types";
import { normalizePathForCacheCompare } from "../path/cachePath";
import { ensureStartupPathRootAvailable } from "../path/startupPathAvailabilityRuntime";
import { createSharedFolderReconciliationRuntime } from './sharedFolderReconciliationRuntime'
import { createSharedFolderNotificationRuntime } from './sharedFolderNotificationRuntime'
import { sharedWatcherInventory } from './sharedWatcherInventoryRuntime'
import type { WatchedFolderApplyContext, WatcherMetadataInventory } from './watched-folder-index/watchedFolderInventoryRuntime'
import type { SharedWatchStatus } from '../../shared/sharedWatchStatus'
import type { SharedIoProcessError } from '../path/sharedIoProcessRuntime'

import { retireFolderWatcherRegistration } from './folderWatcherRegistrationRuntime';
export { currentFolderWatcherRegistrationGeneration } from './folderWatcherRegistrationRuntime';

export interface PendingFolderChange {
  folder: string;
  eventType: string;
  fileName: string;
  receivedAt: number;
  origin?: "fs-watch" | "shared-poll-initial" | "shared-poll-diff";
  triggerEventType?: string;
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
    replayUnchanged?: boolean,
    context?: WatchedFolderApplyContext,
  ) => Promise<FontIndexChangePayload>;
  syncMergedIndexForRootIncremental?: (
    rootPath: string,
    payload: FontIndexChangePayload,
    reason: string,
  ) => Promise<void>;
  syncMergedIndexForRootSnapshot?: (rootPath: string, reason: string) => Promise<void>;
  ensureSourceReady?: (rootPath: string, signal: AbortSignal) => Promise<void>;
  isScanActive?: () => boolean;
  getSharedWatchWorkerPath?: () => Promise<string | undefined>;
}

export interface FolderWatcherRuntime {
  stopFolderWatchers: () => void;
  awaitFolderWatchersClosed: () => Promise<void>;
  getSharedWatchStatus: () => SharedWatchStatus;
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
  let folderWatchers: Array<{ close(): void }> = [];
  let folderWatchTimer: ReturnType<typeof setTimeout> | null = null;
  let currentFolderWatchSignature = "";
  let folderWatchersHealthy = false;
  let folderWatcherIgnoreUntil = 0;
  const pendingFolderChanges = new Map<string, PendingFolderChange>();
  const recoveryBatches = new Map<string, PendingFolderChange[]>();
  const deferredRecoveryBatches = new Map<string, PendingFolderChange[]>();
  let delayedDuringScanLoggedAt = 0;
  let watcherGeneration = 0;
  let flushInFlight: Promise<void> | null = null;
  let flushRequested = false;
  let requestedFolders: string[] = [];
  let generationController = new AbortController();
  const sharedReconcilers = new Map<string, ReturnType<typeof createSharedFolderReconciliationRuntime>>();
  type SharedInventoryJob = { inventory: WatcherMetadataInventory; signal: AbortSignal; forceVerifyPaths: ReadonlySet<string>; onProgress: (pendingCount: number) => void; recoverProjection: boolean; settle: (committed: boolean) => void };
  const sharedInventories = new Map<string, SharedInventoryJob>();
  const closingWatchers = new Set<Promise<void>>();
  const notifications = createSharedFolderNotificationRuntime({ getWorkerPath: options.getSharedWatchWorkerPath, log: options.appendStartupLog });
  onApplicationResumed(() => { void startWatchingFolders(requestedFolders).catch(error => options.appendStartupLog(`watcher resume failed: ${String(error)}`)); });

  function stopFolderWatchers(): void {
    watcherGeneration += 1;
    retireFolderWatcherRegistration();
    generationController.abort();
    generationController = new AbortController();
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
    deferredRecoveryBatches.clear();
    for (const job of sharedInventories.values()) job.settle(false);
    sharedInventories.clear();
    sharedReconcilers.clear();

    if (folderWatchTimer) {
      clearTimeout(folderWatchTimer);
      folderWatchTimer = null;
    }
  }

  async function awaitFolderWatchersClosed(): Promise<void> {
    await Promise.all([...closingWatchers]);
    await notifications.whenClosed();
    await flushInFlight;
  }

  function getSharedWatchStatus(): SharedWatchStatus {
    return { roots: [...sharedReconcilers].map(([rootPath, reconciler]) => {
      const { phase, lastCheckedAt, pendingCount } = reconciler.status();
      return { rootPath, phase, lastCheckedAt, pendingCount };
    }) };
  }

  function sendFontIndexChanged(payload: FontIndexChangePayload): void {
    const metricsOnly = payload.source === 'metrics' && Number.isSafeInteger(payload.metricsRevision) && Number(payload.metricsRevision) > 0;
    if (payload.source === 'metrics' && !metricsOnly) return;
    if (
      !payload.upserts.length &&
      !payload.deletes.length &&
      !payload.errors?.length &&
      payload.source !== 'projection' && !metricsOnly
    )
      return;

    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send("font-index:changed", payload);
      }
    }
  }

  function recoveryRootKey(rootPath: string): string {
    return normalizePathForCacheCompare(resolve(rootPath));
  }

  function recoveryItems(
    rootPath: string,
    changes: PendingFolderChange[],
    payload?: FontIndexChangePayload,
  ): PendingFolderChange[] {
    const retries = [
      ...changes,
      ...(payload?.deletes || []).map((item) => ({
        folder: rootPath,
        fileName: item.relativePath,
        eventType: "rescan",
        receivedAt: Date.now(),
      })),
    ];
    return Array.from(
      new Map(
        retries.map((item) => [
          String(item.fileName || ".").toLowerCase(),
          { ...item, folder: rootPath, fileName: String(item.fileName || "."), eventType: "rescan" },
        ]),
      ).values(),
    );
  }

  function queueRecovery(rootPath: string, changes: PendingFolderChange[], payload?: FontIndexChangePayload): void {
    const key = recoveryRootKey(rootPath);
    if (!currentFolderWatchSignature.split("\n").includes(key)) return;
    // Re-read current files; never replay a failed resource operation or old mutation payload.
    const retries = recoveryItems(rootPath, [...(recoveryBatches.get(key) || []), ...changes], payload);
    if (!retries.length) return;
    recoveryBatches.set(key, retries);
    schedulePendingFolderFlush(Math.max(options.flushDebounceMs, folderWatcherIgnoreUntil - Date.now()));
  }

  function deferRecovery(
    rootPath: string,
    changes: PendingFolderChange[],
    payload: FontIndexChangePayload | undefined,
    reason: string,
  ): void {
    const key = recoveryRootKey(rootPath);
    const queuedForRoot: PendingFolderChange[] = [];
    for (const [pendingKey, item] of pendingFolderChanges) {
      if (recoveryRootKey(item.folder) !== key) continue;
      queuedForRoot.push(item);
      pendingFolderChanges.delete(pendingKey);
    }
    const retries = recoveryItems(
      rootPath,
      [
        ...(deferredRecoveryBatches.get(key) || []),
        ...(recoveryBatches.get(key) || []),
        ...queuedForRoot,
        ...changes,
      ],
      payload,
    );
    recoveryBatches.delete(key);
    if (retries.length) deferredRecoveryBatches.set(key, retries);
    options.appendStartupLog(
      `folder watcher recovery deferred: ${rootPath}; reason=${reason}; affected=${retries.length}; awaiting next concrete watcher event or manual refresh`,
    );
  }

  function releaseDeferredRecovery(change: PendingFolderChange): boolean {
    const rootPath = resolve(change.folder);
    const key = recoveryRootKey(rootPath);
    const deferred = deferredRecoveryBatches.get(key);
    if (!deferred?.length) return false;
    deferredRecoveryBatches.delete(key);
    recoveryBatches.set(
      key,
      recoveryItems(rootPath, [...deferred, change]),
    );
    options.appendStartupLog(
      `folder watcher deferred recovery released by concrete event: ${rootPath} ${change.fileName}`,
    );
    return true;
  }

  async function flushPendingFolderChangesPassUnmeasured(
    generation: number,
  ): Promise<void> {
    const changes = Array.from(pendingFolderChanges.values());
    pendingFolderChanges.clear();
    const recovering = Array.from(recoveryBatches.values());
    recoveryBatches.clear();
    const inventories = Array.from(sharedInventories.values());
    sharedInventories.clear();
    if ((!changes.length && !recovering.length && !inventories.length) || generation !== watcherGeneration) {
      for (const job of inventories) job.settle(false);
      return;
    }

    const grouped = new Map<string, PendingFolderChange[]>();
    for (const change of changes) {
      const key = normalizePathForCacheCompare(resolve(change.folder));
      const items = grouped.get(key) || [];
      items.push(change);
      grouped.set(key, items);
    }

    const jobs: Array<{ group: PendingFolderChange[]; recovery: boolean; inventoryJob?: SharedInventoryJob }> = [
      ...recovering.map((group) => ({ group, recovery: true })),
      ...Array.from(grouped.values(), (group) => ({ group, recovery: false })),
      ...inventories.map(inventoryJob => ({ inventoryJob, recovery: false, group: [{ folder: inventoryJob.inventory.rootPath, eventType: 'rescan', fileName: '.', receivedAt: Date.now(), origin: 'shared-poll-diff' as const }] })),
    ];
    for (const { group, recovery, inventoryJob } of jobs) {
      if (generation !== watcherGeneration) {
        for (const job of inventories) job.settle(false);
        return;
      }
      const rootPath = resolve(group[0]?.folder || "");
      let payload: FontIndexChangePayload | undefined;
      const signal = inventoryJob?.signal || generationController.signal;
      const assertCurrent = () => {
        if (signal.aborted || isApplicationClosing() || generation !== watcherGeneration) throw new Error('watcher-generation-cancelled');
        if (options.isScanActive?.()) throw new Error('watcher-scan-preempted');
      };
      try {
        assertCurrent();
        if (!inventoryJob && !recovery && await options.watcherChangeBatchLooksUnchanged(rootPath, group)) {
          if (generation !== watcherGeneration) return;
          options.appendStartupLog(
            `font index watcher batch skipped unchanged: ${rootPath}, events=${group.length}, recovery=false, samples=${JSON.stringify(group.slice(0, 8).map(change => ({ path: change.fileName, type: change.eventType, trigger: change.triggerEventType || change.eventType, origin: change.origin || 'unspecified' })))}, omitted=${Math.max(0, group.length - 8)}`,
          );
          continue;
        }

        if (generation !== watcherGeneration) return;
        payload = await withSharedIoSignal(signal, () => options.applyWatchedFolderChangesToIndex(group, recovery || (!!inventoryJob?.recoverProjection && !options.syncMergedIndexForRootSnapshot), { inventory: inventoryJob?.inventory, forceVerifyPaths: inventoryJob?.forceVerifyPaths, onProgress: inventoryJob?.onProgress, signal, assertCurrent }));
        if (generation !== watcherGeneration) {
          options.appendStartupLog(
            `font index watcher batch result discarded after watcher restart: ${rootPath}, events=${group.length}`,
          );
          if (!inventoryJob) queueRecovery(rootPath, group, payload);
          return;
        }
        assertCurrent();
        if ((recovery || inventoryJob?.recoverProjection) && options.syncMergedIndexForRootSnapshot) {
          await withSharedIoSignal(signal, () => options.syncMergedIndexForRootSnapshot!(rootPath, `watcher-recovery:${rootPath}`));
        } else if ((payload.upserts.length || payload.deletes.length) && options.syncMergedIndexForRootIncremental) {
          await withSharedIoSignal(signal, () => options.syncMergedIndexForRootIncremental!(rootPath, payload!, `watcher:${rootPath}`));
        }
        assertCurrent();
        if (generation !== watcherGeneration) {
          options.appendStartupLog(
            `font index watcher notification discarded after watcher restart: ${rootPath}, events=${group.length}`,
          );
          if (!inventoryJob) queueRecovery(rootPath, group, payload);
          return;
        }
        options.appendStartupLog(
          `font index watcher batch applied: ${rootPath}, events=${group.length}, upserts=${payload.upserts.length}, deletes=${payload.deletes.length}, errors=${payload.errors?.length || 0}`,
        );
        sendFontIndexChanged(inventoryJob?.recoverProjection && options.syncMergedIndexForRootSnapshot ? { ...payload, source: 'projection' } : payload);
        if (inventoryJob) { inventoryJob.settle(!payload.errors?.length); continue; }
        if (payload.errors?.length) {
          if (!recovery) queueRecovery(rootPath, group, payload);
          else {
            deferRecovery(rootPath, group, payload, "recovery-errors");
            options.appendStartupLog(`folder watcher recovery exhausted: ${rootPath}; waiting for the next concrete event or manual refresh`);
          }
        }
      } catch (error) {
        const sharedError = error && typeof error === 'object' && (error as SharedIoProcessError).sharedIo === true ? error as SharedIoProcessError : undefined;
        if (sharedError?.closed) { try { await sharedError.closed; } catch { /* Preserve the original apply failure. */ } }
        if (inventoryJob) {
          // The root's owner retries a fresh complete inventory; never replay stale snapshots.
          options.appendStartupLog(`shared watcher index apply retained: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const recoveryError = error && typeof error === "object"
          ? error as { watcherRecoveryChanges?: PendingFolderChange[]; watcherRecoveryDisposition?: "defer" }
          : undefined;
        const hints = recoveryError?.watcherRecoveryChanges;
        if (recoveryError?.watcherRecoveryDisposition === "defer") {
          deferRecovery(rootPath, [...group, ...(hints || [])], payload, "persistence");
        } else if (!recovery) {
          queueRecovery(rootPath, [...group, ...(hints || [])], payload);
        } else {
          deferRecovery(rootPath, [...group, ...(hints || [])], payload, "recovery-exhausted");
          options.appendStartupLog(`folder watcher recovery exhausted: ${rootPath}; waiting for the next concrete event or manual refresh`);
        }
        options.appendStartupLog(
          `font index watcher batch failed: ${rootPath}, events=${group.length}, ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        inventoryJob?.settle(false);
      }
    }
  }

  function flushPendingFolderChangesPass(generation: number): Promise<void> {
    return withOperationWork('watcher-batch', options.appendStartupLog, () => flushPendingFolderChangesPassUnmeasured(generation));
  }

  async function flushPendingFolderChanges(): Promise<void> {
    if (flushInFlight) {
      flushRequested = true;
      await flushInFlight;
      if ((pendingFolderChanges.size > 0 || recoveryBatches.size > 0 || sharedInventories.size > 0) && !flushInFlight) {
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
        (flushRequested || pendingFolderChanges.size > 0 || recoveryBatches.size > 0 || sharedInventories.size > 0);
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
    origin: PendingFolderChange['origin'] = 'fs-watch',
  ): void {
    if (isApplicationClosing()) return;
    if (options.isIgnoredWatcherPath(fileName)) return;
    const shared = sharedReconcilers.get(recoveryRootKey(folder));
    if (shared) { shared.requestReconciliation(true, fileName ? [fileName] : []); return; }

    if (Date.now() < folderWatcherIgnoreUntil) {
      if (options.verboseLogs)
        options.appendStartupLog(
          `folder watcher initial event deferred by grace window: ${folder} ${eventType} ${fileName || ""}`,
        );
    }

    const normalizedFileName = String(fileName || "");
    const changeFileName = normalizedFileName || ".";
    const changeEventType = normalizedFileName ? eventType : "rescan";
    const change: PendingFolderChange = {
      folder,
      eventType: changeEventType,
      fileName: changeFileName,
      receivedAt: Date.now(),
      origin,
      triggerEventType: eventType,
    };
    const rootKey = recoveryRootKey(folder);
    if (!normalizedFileName) {
      if (deferredRecoveryBatches.has(rootKey)) {
        options.appendStartupLog(
          `folder watcher root diff suppressed while recovery is deferred: ${folder} ${eventType}`,
        );
        return;
      }
      options.appendStartupLog(
        `folder watcher event without file name queued for root diff: ${folder} ${eventType}`,
      );
    } else if (releaseDeferredRecovery(change)) {
      schedulePendingFolderFlush(Math.max(options.flushDebounceMs, folderWatcherIgnoreUntil - Date.now()));
      return;
    }

    const key = `${normalizePathForCacheCompare(folder)}\0${changeFileName.toLowerCase()}\0${changeEventType}`;
    pendingFolderChanges.set(key, change);

    schedulePendingFolderFlush(Math.max(options.flushDebounceMs, folderWatcherIgnoreUntil - Date.now()));
  }

  function startSharedPolling(folder: string, generation: number): { close(): void } {
    const key = recoveryRootKey(folder);
    // A interrupted checkpoint can outlive this process without a published merged row.
    // Repair the local projection once at startup; subsequent unchanged polls do no index work.
    let recoverProjection = true;
    const notifier = notifications.watch(folder, (delivered, paths) => reconciler.requestReconciliation(delivered, paths));
    const reconciler = createSharedFolderReconciliationRuntime({
      isCurrent: () => !isApplicationClosing() && generation === watcherGeneration,
      isBusy: options.isScanActive,
      ensureSourceReady: signal => withSharedIoSignal(signal, () => options.ensureSourceReady?.(folder, signal) || Promise.resolve()),
      log: options.appendStartupLog,
      collect: signal => withSharedIoSignal(signal, async () => {
        try {
          if (!await ensureStartupPathRootAvailable(folder, options.appendStartupLog, 'shared-watcher-poll', { background: true })) throw new Error('root-offline');
          // Arm the OS monitor before the first inventory. Its bounded startup failure falls back to polling.
          await notifier.ensureStarted();
          if (signal.aborted) throw new Error('watcher-generation-cancelled');
          const { result } = await executeSharedFile({ operation: 'treeSnapshot', path: folder }, undefined, signal);
          return sharedWatcherInventory(folder, result.value);
        } catch (error) {
          // A surviving handle may still address the old share/directory after reconnection.
          if (!signal.aborted) notifier.invalidate();
          throw error;
        }
      }),
      apply: (inventory, signal, forceVerifyPaths, onProgress) => new Promise<boolean>(resolve => {
        if (signal.aborted || generation !== watcherGeneration) { resolve(false); return; }
        let settled = false;
        const settle = (committed: boolean) => { if (settled) return; settled = true; recoverProjection = !committed; signal.removeEventListener('abort', abort); resolve(committed); };
        const abort = () => settle(false);
        signal.addEventListener('abort', abort, { once: true });
        sharedInventories.get(key)?.settle(false);
        sharedInventories.set(key, { inventory, signal, forceVerifyPaths, onProgress, recoverProjection, settle });
        schedulePendingFolderFlush(Math.max(options.flushDebounceMs, folderWatcherIgnoreUntil - Date.now()));
      }),
    });
    sharedReconcilers.set(key, reconciler);
    reconciler.start();
    return { close() {
      reconciler.close();
      notifier.close();
      const closing = Promise.all([reconciler.whenIdle(), notifier.whenClosed()]).then(() => undefined);
      closingWatchers.add(closing);
      void closing.finally(() => closingWatchers.delete(closing)).catch(() => undefined);
    } };
  }

  async function startWatchingFolders(folders: string[]): Promise<boolean> {
    if (isApplicationClosing()) return false;
    requestedFolders = [...folders];
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
        if (isApplicationClosing() || generation !== watcherGeneration) return true;
        if ((await sharedIoResourceKeys([folder])).length) {
          if (isApplicationClosing() || generation !== watcherGeneration) return true;
          folderWatchers.push(startSharedPolling(folder, generation));
          options.appendStartupLog(`shared folder polling started: ${folder}`);
          continue;
        }
        if (!rootAvailable) {
          options.appendStartupLog(
            `folder watcher skipped unavailable root: ${folder}`,
          );
          continue;
        }
        const stat = await fsp.stat(folder);
        if (isApplicationClosing() || generation !== watcherGeneration) return true;
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
        if (isApplicationClosing() || generation !== watcherGeneration) return true;
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
    awaitFolderWatchersClosed,
    getSharedWatchStatus,
    sendFontIndexChanged,
    flushPendingFolderChanges,
    notifyFolderChanged,
    startWatchingFolders,
  };
}
