import { createWindowsFontRuntime } from "./fontRuntime";

export type MainWindowsFontRuntimeOptions = {
  appName: string;
  fontExtensions: Set<string>;
  dataRoot: () => string;
  dataPath: (name: string) => string;
  appendStartupLog: (message: string) => void;
  runRustFontResourceAdd?: any;
  runRustFontResourceRemove?: any;
  runRustFontRegistryApply?: any;
  runRustFontRegistryDelete?: any;
  runRustFontChangeNotify?: any;
};

export function createMainWindowsFontRuntime(
  options: MainWindowsFontRuntimeOptions,
): ReturnType<typeof createWindowsFontRuntime> {
  return createWindowsFontRuntime({
    appName: options.appName,
    fontExtensions: options.fontExtensions,
    dataRoot: options.dataRoot,
    dataPath: options.dataPath,
    appendStartupLog: options.appendStartupLog,
    runRustFontResourceAdd: options.runRustFontResourceAdd,
    runRustFontResourceRemove: options.runRustFontResourceRemove,
    runRustFontRegistryApply: options.runRustFontRegistryApply,
    runRustFontRegistryDelete: options.runRustFontRegistryDelete,
    runRustFontChangeNotify: options.runRustFontChangeNotify,
  });
}
