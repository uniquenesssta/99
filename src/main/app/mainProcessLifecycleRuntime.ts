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
  flushPendingTemporaryFontDeletes: (reason: string) => Promise<void>;
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
  markCleanShutdownSync: () => void;
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
  let rendererCloseForQuitRunning = false;
  let quitCleanupRunning = false;
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
    showExistingWindow();
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
    const schemaAuditTimer = setTimeout(() => {
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
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  function restoreAfterQuitAbort(): void {
    quitCleanupRunning = false;
    if (startupBackgroundTasksEnabled) startBackgroundTaskScheduler();
    const windows = BrowserWindow.getAllWindows();
    if (!windows.length) createWindow();
    BrowserWindow.getAllWindows().forEach((window) => {
      if (window.isDestroyed()) return;
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      window.focus();
    });
  }

  app.on("before-quit", (event) => {
    if (quitCleanupDone) return;

    const openWindows = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
    if (openWindows.length) {
      event.preventDefault();
      if (rendererCloseForQuitRunning) return;
      rendererCloseForQuitRunning = true;
      appendLog(`before-quit renderer flush requested: windows=${openWindows.length}`);
      void requestRendererWindowsCloseForQuit()
        .then((closed) => {
          rendererCloseForQuitRunning = false;
          if (closed) {
            appendLog("before-quit renderer flush completed");
            app.quit();
          } else {
            appendLog("before-quit renderer flush cancelled; application remains open");
          }
        })
        .catch((error) => {
          rendererCloseForQuitRunning = false;
          appendLog(
            `before-quit renderer flush failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          flushStartupLogSync();
        });
      return;
    }

    event.preventDefault();
    if (quitCleanupRunning) return;

    quitCleanupRunning = true;
    appendLog(
      `before-quit cleanup requested: activationPending=${hasPendingActivationInstallStatusSave()}, activationInFlight=${hasInFlightActivationInstallStatusSave()}`,
    );
    stopBackgroundTaskScheduler();
    BrowserWindow.getAllWindows().forEach((window) => window.hide());

    void (async () => {
      if (process.platform === "win32") {
        const result = await cleanupTemporaryActiveFontsUntilEmpty("quit");
        await flushPendingTemporaryFontDeletes("quit");
        if (result.remaining > 0) {
          restoreAfterQuitAbort();
          dialog.showErrorBox(
            "临时激活字体仍未完全移除",
            `仍有 ${result.remaining} 个临时激活字体没有完全移除。请关闭 Photoshop、Illustrator 或其他正在使用字体的软件后，再次退出。软件不会在未完全移除临时激活字体时退出。`,
          );
          return;
        }
      }

      try {
        await flushActivationInstallStatusSave("before-quit");
      } catch (error) {
        appendLog(
          `before-quit activation status flush failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        const target = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
        const messageBoxOptions = {
          type: "warning" as const,
          title: "安装状态尚未保存",
          message: "最后一批字体安装或激活状态未能写入数据库。",
          detail: "返回软件后会继续自动重试。仍然退出不会影响字体文件，但下次启动时可能需要重新校验安装状态。",
          buttons: ["返回软件", "仍然退出"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        };
        const prompt = target
          ? await dialog.showMessageBox(target, messageBoxOptions)
          : await dialog.showMessageBox(messageBoxOptions);
        if (prompt.response !== 1) {
          restoreAfterQuitAbort();
          return;
        }
        appendLog("before-quit activation status flush force-skipped by user");
      }

      stopFolderWatchers();
      stopPerformanceLogSampler();
      flushPerformanceLogs("before-quit");
      appendLog(
        `before-quit cleanup completed: activationPending=${hasPendingActivationInstallStatusSave()}, activationInFlight=${hasInFlightActivationInstallStatusSave()}`,
      );
      await flushStartupLogAsync();
      quitCleanupDone = true;
      quitCleanupRunning = false;
      app.quit();
    })().catch((error) => {
      appendLog(
        "before-quit cleanup failed: " +
          (error instanceof Error ? error.stack || error.message : String(error)),
      );
      flushStartupLogSync();
      restoreAfterQuitAbort();
      dialog.showErrorBox(
        "退出清理失败",
        error instanceof Error ? error.message : String(error),
      );
    });
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
