import { runtimePreloadSource } from "../preload/runtimePreloadSource";
import { loadErrorHtml } from "../ui/loadErrorPage";
import {
  createMainWindowsFontRuntime,
  type MainWindowsFontRuntimeOptions,
} from "../windows/mainWindowsFontRuntime";
import {
  createFontPathAuthorizationRuntime,
  type FontPathRootProvider,
  type MainProcessIndexedFontIdentity,
} from "../path/fontPathAuthorizationRuntime";
import { createProgressEventRuntime } from "./progressEventRuntime";
import { createWindowRuntime } from "./windowRuntime";

export type MainWindowAndFontRuntimeOptions = Omit<
  MainWindowsFontRuntimeOptions,
  "dataPath"
> & {
  appInstallDir: () => string;
  dataPath: (...parts: string[]) => string;
  verboseRendererLogs: boolean;
  indexProgressMinIntervalMs: number;
  loadWatchedFontRoots: FontPathRootProvider;
  isMainProcessIndexedFont: (
    identity: MainProcessIndexedFontIdentity,
  ) => boolean | Promise<boolean>;
};

export function createMainWindowAndFontRuntime(
  deps: MainWindowAndFontRuntimeOptions,
) {
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

  const fontPathAuthorizationRuntime = createFontPathAuthorizationRuntime({
    fontExtensions: deps.fontExtensions,
    readRoots: async () => [
      ...(await deps.loadWatchedFontRoots()),
      windowsFontRuntime.windowsFontsDir(),
      windowsFontRuntime.currentUserFontsDir(),
    ],
    watchedRoots: deps.loadWatchedFontRoots,
    appOwnedRoots: () => [windowsFontRuntime.currentUserFontsDir()],
    isMainProcessIndexedFont: deps.isMainProcessIndexedFont,
  });

  const windowRuntime = createWindowRuntime({
    appName: deps.appName,
    appInstallDir: deps.appInstallDir,
    dataPath: deps.dataPath,
    runtimePreloadSource,
    loadErrorHtml,
    appendLog: deps.appendStartupLog,
    verboseRendererLogs: deps.verboseRendererLogs,
    authorizeFontRead: fontPathAuthorizationRuntime.authorizeFontRead,
  });

  const progressEventRuntime = createProgressEventRuntime({
    indexProgressMinIntervalMs: deps.indexProgressMinIntervalMs,
    sendToRendererWindows: windowRuntime.sendToRendererWindows,
  });

  return {
    ...windowRuntime,
    ...progressEventRuntime,
    ...windowsFontRuntime,
    ...fontPathAuthorizationRuntime,
  };
}
