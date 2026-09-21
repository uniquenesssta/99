import { createShutdownCoordinator, isApplicationClosing, type ShutdownOutcome } from './shutdownCoordinatorRuntime';
import { app,BrowserWindow,dialog,Menu,shell } from "electron";
import { registerPackagedSessionSecurity } from "../security/appSecurityRuntime";
import { configureElectronUserDataRoot } from "./appDataRootPolicyRuntime";
import { verifyPackagedAppIntegrity } from "../security/appIntegrityRuntime";

export type MainProcessLifecycleRuntimeOptions = {
  appName: string;
  appId: string;
  buildMarker: string;
  logSchemaVersion: number;
  cacheArchitectureVersion: number;
  watcherStartupGraceMs: number;
  editionLogLine: string;
  scanTuningLogLine: string;
  gpuAccelerationSwitches: Array<[name: string, value?: string]>;
  gpuDisableSwitches: string[];
  configureGpuAcceleration: (
    electronApp: typeof app,
    switches: Array<[name: string, value?: string]>,
  ) => void;
  appendGpuStartupSwitchDiagnostics: (
    electronApp: typeof app,
    enabledSwitches: Array<[name: string, value?: string]>,
    disabledSwitches: string[],
    appendLog: (message: string) => void,
  ) => void;
  appendGpuDiagnostics: (
    electronApp: typeof app,
    appendLog: (message: string) => void,
    reason: string,
  ) => Promise<void> | void;
  appendLog: (message: string) => void;
  beginStartupSessionSync: () => void;
  ensureDataRootSync: () => void;
  migrateLegacyUserDataIfNeeded: () => Promise<void>;
  initializeCacheArchitecture: () => Promise<void>;
  diagnoseRustCoreWorker: () => Promise<unknown>;
  dataRoot: () => string;
  dataRootErrorMessage: (error: unknown) => string;
  showExistingWindow: () => void;
  requestRendererWindowsCloseForQuit: () => Promise<boolean>;
  logPath: () => string;
  ioLaneSummary: () => string;
  cleanupTemporaryActiveFontsUntilEmpty: (
    reason?: "startup" | "quit" | "manual",
    maxPasses?: number,
  ) => Promise<{ remaining: number }>;
  flushPendingTemporaryFontDeletes: (reason: string) => Promise<{ remaining: number }>;
  runStartupCriticalSchemaAudit: () => Promise<void>;
  registerFontProtocol: () => void;
  registerIpc: () => void;
  startPerformanceLogSampler: () => void;
  stopPerformanceLogSampler: () => void;
  flushPerformanceLogs: (reason?: string) => void;
  createWindow: () => void;
  runStartupDatabaseMaintenance: () => Promise<unknown>;
  startupDbMaintenanceIdleDelayMs: number;
  startupBackgroundTasksEnabled: boolean;
  startBackgroundTaskScheduler: () => void;
  stopBackgroundTaskScheduler: () => void;
  stopFolderWatchers: () => void;
  flushActivationInstallStatusSave: (reason: string) => Promise<void>;
  hasPendingActivationInstallStatusSave: () => boolean;
  hasInFlightActivationInstallStatusSave: () => boolean;
  setCacheKvs: (
    key: string,
    value: unknown,
    valueType?: "string" | "number" | "bigint" | "boolean" | "symbol" | "undefined" | "object" | "function",
  ) => Promise<unknown>;
  dbQueryWorkerShutdown: () => void;
  stopRustCoreDaemon: () => void;
  markCleanShutdownSync: (outcome?: ShutdownOutcome) => void;
  flushStartupLogAsync: () => Promise<void>;
  flushStartupLogSync: () => void;
};

export function registerMainProcessLifecycleRuntime(
  options: MainProcessLifecycleRuntimeOptions,
): void {
  const {
    appName,
    appId,
    buildMarker,
    logSchemaVersion,
    cacheArchitectureVersion,
    watcherStartupGraceMs,
    editionLogLine,
    scanTuningLogLine,
    gpuAccelerationSwitches,
    gpuDisableSwitches,
    configureGpuAcceleration,
    appendGpuStartupSwitchDiagnostics,
    appendGpuDiagnostics,
    appendLog,
    beginStartupSessionSync,
    ensureDataRootSync,
    migrateLegacyUserDataIfNeeded,
    initializeCacheArchitecture,
    diagnoseRustCoreWorker,
    dataRoot,
    dataRootErrorMessage,
    showExistingWindow,
    requestRendererWindowsCloseForQuit,
    logPath,
    ioLaneSummary,
    cleanupTemporaryActiveFontsUntilEmpty,
    flushPendingTemporaryFontDeletes,
    runStartupCriticalSchemaAudit,
    registerFontProtocol,
    registerIpc,
    startPerformanceLogSampler,
    stopPerformanceLogSampler,
    flushPerformanceLogs,
    createWindow,
    runStartupDatabaseMaintenance,
    startupDbMaintenanceIdleDelayMs,
    startupBackgroundTasksEnabled,
    startBackgroundTaskScheduler,
    stopBackgroundTaskScheduler,
    stopFolderWatchers,
    flushActivationInstallStatusSave,
    hasPendingActivationInstallStatusSave,
    hasInFlightActivationInstallStatusSave,
    setCacheKvs,
    dbQueryWorkerShutdown,
    stopRustCoreDaemon,
    markCleanShutdownSync,
    flushStartupLogAsync,
    flushStartupLogSync,
  } = options;

  let gpuInfoUpdateSeen = false;
  let quitCleanupDone = false;
  const installQuitArgs = new Set(["--hfm-quit-for-install", "--quit-for-install"]);

  function hasInstallQuitArg(commandLine: readonly string[]): boolean {
    return commandLine.some((arg) => installQuitArgs.has(arg));
  }

  function quitForInstaller(source: string): void {
    appendLog(`installer quit request received: ${source}`);
    app.quit();
  }

  function appendStartupIdentityDiagnostics(electronUserDataRoot: string): void {
    appendLog(
      `startup identity: buildMarker=${buildMarker}, logSchema=${logSchemaVersion}, appVersion=${app.getVersion()}, packaged=${app.isPackaged}, pid=${process.pid}, platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, chrome=${process.versions.chrome}, node=${process.versions.node}`,
    );
    appendLog(
      `startup paths: exe=${app.getPath("exe")}, appPath=${app.getAppPath()}, resources=${process.resourcesPath || ""}, cwd=${process.cwd()}, electronUserData=${electronUserDataRoot}`,
    );
    appendLog(
      `startup env: NODE_ENV=${process.env.NODE_ENV || ""}, ELECTRON_RENDERER_URL=${process.env.ELECTRON_RENDERER_URL || ""}, VITE_DEV_SERVER_URL=${process.env.VITE_DEV_SERVER_URL || ""}, HFM_DATA_DIR=${process.env.HFM_DATA_DIR || ""}, HFM_LOG_DETAIL=${process.env.HFM_LOG_DETAIL || "normal"}, HFM_RUST_CORE=${process.env.HFM_RUST_CORE || "auto"}, HFM_RUST_CORE_REQUIRED=${process.env.HFM_RUST_CORE_REQUIRED || "0"}`,
    );
  }

  process.on("uncaughtException", (error) => {
    appendLog(
      "main uncaught exception captured: " +
        (error instanceof Error ? error.stack || error.message : String(error)),
    );
    flushStartupLogSync();
  });
  process.on("unhandledRejection", (reason) => {
    appendLog(
      "main unhandled rejection captured: " +
        (reason instanceof Error ? reason.stack || reason.message : String(reason)),
    );
  });

  configureGpuAcceleration(app, gpuAccelerationSwitches);
  app.setName(appName);
  const electronUserDataRoot = configureElectronUserDataRoot({ appName, dataDirName: 'data' });
  appendStartupIdentityDiagnostics(electronUserDataRoot);
  if (process.platform === "win32") {
    app.setAppUserModelId(appId);
  }
  app.on("gpu-info-update", () => {
    gpuInfoUpdateSeen = true;
    void appendGpuDiagnostics(app, appendLog, "gpu-info-update");
  });

  const launchedForInstallerQuit = hasInstallQuitArg(process.argv);
  const gotSingleInstanceLock = app.requestSingleInstanceLock();

  if (!gotSingleInstanceLock) {
    app.quit();
    return;
  }

  if (launchedForInstallerQuit) {
    quitForInstaller("primary-process-startup");
    return;
  }

  app.on("second-instance", (_event, commandLine) => {
    if (hasInstallQuitArg(commandLine)) {
      quitForInstaller("second-instance");
      return;
    }
    if (!isApplicationClosing()) showExistingWindow();
  });

  app.whenReady().then(async () => {
    const integrityResult = verifyPackagedAppIntegrity(appendLog);
    if (!integrityResult.ok) {
      dialog.showErrorBox(
        `${appName} 文件完整性校验失败`,
        integrityResult.errors.join("\n") || "安装包文件可能被修改或缺失。",
      );
      app.quit();
      return;
    }
    registerPackagedSessionSecurity(appendLog);

    try {
      ensureDataRootSync();
      beginStartupSessionSync();
      await migrateLegacyUserDataIfNeeded();
      await initializeCacheArchitecture();
      await diagnoseRustCoreWorker().catch((error) => {
        appendLog(
          "rust core worker diagnostic failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
        throw error;
      });
      appendLog("data root ready: " + dataRoot());
      appendLog(
        `cache architecture v${cacheArchitectureVersion} ready: startupAutoScan=false watcherGraceMs=${watcherStartupGraceMs}`,
      );
    } catch (error) {
      dialog.showErrorBox(
        `${appName} 数据目录不可写`,
        dataRootErrorMessage(error),
      );
      app.quit();
      return;
    }

    if (app.isPackaged) {
      Menu.setApplicationMenu(null);
    } else {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "文件",
            submenu: [{ role: "quit", label: "退出" }],
          },
          {
            label: "查看",
            submenu: [
              { role: "reload", label: "重新加载" },
              { role: "toggleDevTools", label: "开发者工具" },
              { type: "separator" },
              { role: "resetZoom", label: "实际大小" },
              { role: "zoomIn", label: "放大" },
              { role: "zoomOut", label: "缩小" },
              { role: "togglefullscreen", label: "全屏" },
            ],
          },
          {
            label: "帮助",
            submenu: [
              {
                label: "打开本次启动日志",
                click: () => shell.showItemInFolder(logPath()),
              },
            ],
          },
        ]),
      );
    }
    appendLog("app ready");
    appendLog(editionLogLine);
    appendLog(scanTuningLogLine);
    appendLog(ioLaneSummary());
    appendLog("current log file: " + logPath());
    appendGpuStartupSwitchDiagnostics(
      app,
      gpuAccelerationSwitches,
      gpuDisableSwitches,
      appendLog,
    );
    await appendGpuDiagnostics(
      app,
      appendLog,
      gpuInfoUpdateSeen
        ? "app-ready-after-gpu-info-update"
        : "app-ready-before-gpu-info-update",
    );
    try {
      await cleanupTemporaryActiveFontsUntilEmpty("startup", 6);
      await flushPendingTemporaryFontDeletes("startup");
    } catch (error) {
      appendLog(
        "startup temporary cleanup failed: " +
          (error instanceof Error ? error.message : String(error)),
      );
    }
    if (isApplicationClosing()) return;
    const schemaAuditTimer = setTimeout(() => {
      if (isApplicationClosing()) return;
      void runStartupCriticalSchemaAudit().catch((error) => {
        appendLog(
          "startup critical schema audit failed: " +
            (error instanceof Error ? error.message : String(error)),
        );
      });
    }, 1000);
    (schemaAuditTimer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
    appendLog("startup critical schema audit scheduled: non-blocking delayMs=1000");
    registerFontProtocol();
    registerIpc();
    startPerformanceLogSampler();
    createWindow();
    const maintenanceTimer = setTimeout(() => {
      if (isApplicationClosing()) return;
      void runStartupDatabaseMaintenance().catch((error) => {
        appendLog(
          "startup database maintenance failed: " +
            (error instanceof Error ? error.stack || error.message : String(error)),
        );
      });
    }, startupDbMaintenanceIdleDelayMs);
    if (typeof maintenanceTimer.unref === "function") maintenanceTimer.unref();
    if (startupBackgroundTasksEnabled) {
      startBackgroundTaskScheduler();
    } else {
      appendLog(
        "background task scheduler disabled on startup by v2 policy; manual tasks and direct preview generation remain available.",
      );
    }
    void setCacheKvs(
      "app.main_window_created_at",
      new Date().toISOString(),
      "string",
    ).catch(() => undefined);

    app.on("activate", () => {
      if (!isApplicationClosing() && BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  const shutdown = createShutdownCoordinator({
    log: appendLog,
    freeze: () => { stopBackgroundTaskScheduler(); },
    closeRenderers: async () => {
      appendLog("before-quit renderer flush requested");
      const closed = await requestRendererWindowsCloseForQuit();
      appendLog(closed ? "before-quit renderer flush completed" : "before-quit renderer flush cancelled; application remains open");
      return closed;
    },
    restore: () => {
      if (startupBackgroundTasksEnabled) startBackgroundTaskScheduler();
      if (!BrowserWindow.getAllWindows().length) createWindow();
      showExistingWindow();
    },
    cleanup: async () => {
      stopFolderWatchers();
      if (process.platform !== "win32") return { remaining: 0 };
      const active = await cleanupTemporaryActiveFontsUntilEmpty("quit", 1);
      const pending = await flushPendingTemporaryFontDeletes("quit");
      return { remaining: active.remaining + pending.remaining };
    },
    save: async () => {
      await flushActivationInstallStatusSave("before-quit");
      if (hasPendingActivationInstallStatusSave() || hasInFlightActivationInstallStatusSave()) {
        throw new Error("本机安装状态仍有未保存项；恢复记录保留，下次启动需要核验。");
      }
    },
    confirmLoss: async (message) => {
      const result = await dialog.showMessageBox({
        type: "warning", title: "本地状态尚未完整保存",
        message: "本次退出仍有未确认或未保存的数据。",
        detail: `${message}\n返回软件可检查并重试；仍然退出会保留已有恢复记录，但未保存的修改可能丢失。`,
        buttons: ["返回软件", "仍然退出"], defaultId: 0, cancelId: 0, noLink: true,
      });
      return result.response === 1;
    },
    drainLogs: async () => {
      stopPerformanceLogSampler();
      flushPerformanceLogs("before-quit");
      await flushStartupLogAsync();
    },
    terminate: (outcome) => {
      quitCleanupDone = true;
      // app.exit does not emit will-quit. Explicitly stop owned executors first.
      try { stopFolderWatchers(); } catch (error) { try { appendLog(`shutdown watcher stop failed: ${String(error)}`); } catch { /* Continue final teardown. */ } }
      try { stopBackgroundTaskScheduler(); } catch (error) { try { appendLog(`shutdown scheduler stop failed: ${String(error)}`); } catch { /* Continue final teardown. */ } }
      try { stopRustCoreDaemon(); } catch (error) { try { appendLog(`shutdown worker stop failed: ${String(error)}`); } catch { /* Continue final teardown. */ } }
      try { dbQueryWorkerShutdown(); } catch (error) { try { appendLog(`shutdown database stop failed: ${String(error)}`); } catch { /* Continue final teardown. */ } }
      try {
        markCleanShutdownSync(outcome);
        flushStartupLogSync();
      } finally { app.exit(0); }
    },
  });

  app.on("before-quit", (event) => {
    if (quitCleanupDone) return;
    event.preventDefault();
    void shutdown.request();
  });

  app.on("will-quit", () => {
    stopRustCoreDaemon();
    dbQueryWorkerShutdown();
    markCleanShutdownSync();
    flushStartupLogSync();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
