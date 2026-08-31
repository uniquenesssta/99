import { runtimePreloadSource } from "../preload/runtimePreloadSource";
import { loadErrorHtml } from "../ui/loadErrorPage";
import { createMainWindowsFontRuntime } from "../windows/mainWindowsFontRuntime";
import { createProgressEventRuntime } from "./progressEventRuntime";
import { createWindowRuntime } from "./windowRuntime";

export function createMainWindowAndFontRuntime(deps: any): any {
  const windowsFontRuntime = createMainWindowsFontRuntime({
    appName: deps.appName,
    fontExtensions: deps.fontExtensions,
    dataRoot: deps.dataRoot,
    dataPath: deps.dataPath,
    appendStartupLog: deps.appendStartupLog,
    runRustFontResourceAdd: deps.runRustFontResourceAdd,
    runRustFontResourceRemove: deps.runRustFontResourceRemove,
    runRustFontRegistryApply: deps.runRustFontRegistryApply,
    runRustFontRegistryDelete: deps.runRustFontRegistryDelete,
    runRustFontChangeNotify: deps.runRustFontChangeNotify,
  });

  const windowRuntime = createWindowRuntime({
    appName: deps.appName,
    appInstallDir: deps.appInstallDir,
    dataPath: deps.dataPath,
    runtimePreloadSource,
    loadErrorHtml,
    appendLog: deps.appendStartupLog,
    verboseRendererLogs: deps.verboseRendererLogs,
    resolveExistingFontFilePath: (filePath) =>
      windowsFontRuntime.resolveExistingFontFilePath(filePath),
  });

  const progressEventRuntime = createProgressEventRuntime({
    indexProgressMinIntervalMs: deps.indexProgressMinIntervalMs,
    sendToRendererWindows: windowRuntime.sendToRendererWindows,
  });

  return {
    ...windowRuntime,
    ...progressEventRuntime,
    ...windowsFontRuntime,
  };
}
