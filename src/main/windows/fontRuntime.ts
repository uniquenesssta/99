import { createFontChangeBroadcastRuntime } from './runtime/fontChangeBroadcastRuntime'
import { createFontPathResolverRuntime } from './runtime/fontPathResolverRuntime'
import { createFontRefreshRuntime } from './runtime/fontRefreshRuntime'
import { createFontResourceSessionRuntime } from './runtime/fontResourceSessionRuntime'
import { currentUserFontsDir,ensureWindows,windowsFontsDir } from './runtime/fontRuntimePaths'
import type { FontRefreshRuntimeStats,WindowsFontRuntimeOptions } from './runtime/fontRuntimeTypes'
import { missingFontPreviewDataUri } from './runtime/missingFontPreviewRuntime'
import { createNativeFontHelperRuntime } from './runtime/nativeFontHelperRuntime'
import { createTemporaryActiveFontsStoreRuntime } from './runtime/temporaryActiveFontsStoreRuntime'

export type {
FontRefreshMode,
TemporaryActiveFontRecord,
TemporaryActiveFontsFile,
WindowsFontRuntimeOptions
} from './runtime/fontRuntimeTypes'

export function createWindowsFontRuntime(options: WindowsFontRuntimeOptions) {
  const { appName, fontExtensions, dataRoot, dataPath, appendStartupLog } = options
  const fontRefreshRuntimeStats: FontRefreshRuntimeStats = {
    requested: 0,
    coalesced: 0,
    completed: 0,
    failed: 0,
    skippedRecent: 0,
    lastReason: '',
    lastMode: '',
    lastElapsedMs: 0,
    lastBroadcastAt: 0,
    pending: false,
    inFlight: false
  }

  const pathResolverRuntime = createFontPathResolverRuntime({
    fontExtensions,
    appendStartupLog,
    windowsFontsDir,
    currentUserFontsDir
  })

  const temporaryActiveFontsStoreRuntime = createTemporaryActiveFontsStoreRuntime({
    dataRoot,
    dataPath
  })

  const nativeFontHelperRuntime = createNativeFontHelperRuntime({ appendStartupLog })

  const fontChangeBroadcastRuntime = createFontChangeBroadcastRuntime({
    appendStartupLog,
    fontRefreshRuntimeStats,
    runNativeFontHelper: nativeFontHelperRuntime.runNativeFontHelper,
    runRustFontChangeNotify: options.runRustFontChangeNotify
  })

  const fontResourceSessionRuntime = createFontResourceSessionRuntime({
    appendStartupLog,
    fontRefreshRuntimeStats,
    runNativeFontHelper: nativeFontHelperRuntime.runNativeFontHelper,
    nativeFontHelperBatchResult: nativeFontHelperRuntime.nativeFontHelperBatchResult,
    runRustFontResourceAdd: options.runRustFontResourceAdd,
    runRustFontResourceRemove: options.runRustFontResourceRemove,
    runRustFontRegistryApply: options.runRustFontRegistryApply,
    runRustFontRegistryDelete: options.runRustFontRegistryDelete
  })

  const fontRefreshRuntime = createFontRefreshRuntime({
    appName,
    appendStartupLog,
    currentUserFontsDir,
    broadcastFontChange: fontChangeBroadcastRuntime.broadcastFontChange,
    fontRefreshRuntimeStats
  })

  return {
    ensureWindows,
    currentUserFontsDir,
    windowsFontsDir,
    resolveExistingFontFilePath: pathResolverRuntime.resolveExistingFontFilePath,
    missingFontPreviewDataUri,
    loadTemporaryActiveFonts: temporaryActiveFontsStoreRuntime.loadTemporaryActiveFonts,
    saveTemporaryActiveFonts: temporaryActiveFontsStoreRuntime.saveTemporaryActiveFonts,
    runNativeFontHelper: nativeFontHelperRuntime.runNativeFontHelper,
    nativeFontHelperBatchResult: nativeFontHelperRuntime.nativeFontHelperBatchResult,
    addFontResourceSessionBatch: fontResourceSessionRuntime.addFontResourceSessionBatch,
    removeFontResourceSessionBatch: fontResourceSessionRuntime.removeFontResourceSessionBatch,
    writeFontRegistryValuesHKCUBatch: fontResourceSessionRuntime.writeFontRegistryValuesHKCUBatch,
    deleteFontRegistryValuesHKCUBatch: fontResourceSessionRuntime.deleteFontRegistryValuesHKCUBatch,
    addFontResourceSession: fontResourceSessionRuntime.addFontResourceSession,
    removeFontResourceSession: fontResourceSessionRuntime.removeFontResourceSession,
    deleteRegistryValueHKCU: fontResourceSessionRuntime.deleteRegistryValueHKCU,
    requestFontRefresh: fontRefreshRuntime.requestFontRefresh,
    broadcastFontChange: fontChangeBroadcastRuntime.broadcastFontChange,
    scheduleDelayedFontRefresh: fontRefreshRuntime.scheduleDelayedFontRefresh,
    scheduleBackgroundFontRefreshTail: fontRefreshRuntime.scheduleBackgroundFontRefreshTail,
    interactiveFontRefresh: fontRefreshRuntime.interactiveFontRefresh,
    advancedFontRefresh: fontRefreshRuntime.advancedFontRefresh
  }
}
