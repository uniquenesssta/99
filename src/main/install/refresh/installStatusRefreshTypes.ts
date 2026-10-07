import type {
FontItem,
InstallCompareOptions,
InstallCompareResult,
InstallStatusProgressPayload,
InstallStatusRefreshResult,
SystemInstalledFont
} from '../../../shared/types';

export interface InstallStatusRefreshRuntimeDeps {
  appWatchedFolders: () => Promise<string[]>
  loadSharedFontsForFolders: (folders: string[]) => Promise<FontItem[]>
  readInstallStatusIndex: (
    items: FontItem[],
    options?: { enqueueMissTasks?: boolean }
  ) => Promise<{ results: Record<string, InstallCompareResult>; misses: FontItem[] }>
  saveInstallStatusIndex: (
    results: Record<string, InstallCompareResult>,
    itemsById: Map<string, FontItem>,
    options?: { completeTasks?: boolean }
  ) => Promise<void>
  readInstalledTotalSummaryForRoots: (folders: string[]) => Promise<number | null>
  saveInstalledTotalSummaryForRoots: (folders: string[], total: number) => Promise<void>
  getSystemInstalledFontsCached: (force?: boolean) => Promise<SystemInstalledFont[]>
  runRustSystemInstalledFonts?: (input: { windowsFontsDir: string; currentUserFontsDir: string; extensions: string[]; includeNameCandidates?: boolean }) => Promise<{ items: SystemInstalledFont[] } | null>
  runRustInstallStatusCompare?: (input: { appName: string; items: FontItem[]; installed: SystemInstalledFont[] }) => Promise<{ results: Record<string, InstallCompareResult>; count: number; elapsedMs?: number } | null>
  appName?: string
  buildInstalledFontLookupIndex: (installed: SystemInstalledFont[]) => any
  compareFontInstalledWithLookupIndex: (item: FontItem, lookup: any) => InstallCompareResult
  rootForFontPath: (filePath: string, folders: string[]) => Promise<string | null>
  syncMergedIndexAfterInstallStatusRefresh: (roots: string[]) => Promise<void>
  clearFontQueryCaches: () => void
  emitInstallStatusProgress: (
    payload: Omit<InstallStatusProgressPayload, 'at'>
  ) => void
  waitForRendererIdle: (maxWaitMs?: number) => Promise<void>
  delayToEventLoop: () => Promise<void>
  withGlobalIo: <T>(label: string, run: () => Promise<T>, options?: any) => Promise<T>
  execFileAsync: (
    file: string,
    args: string[],
    options?: Record<string, unknown>
  ) => Promise<{ stdout: string }>
  windowsFontsDir: () => string
  currentUserFontsDir: () => string
  fontExtensions: Set<string>
  appendStartupLog: (message: string) => void
  installStatusRefreshBatchSize?: number
  lightweightMissingThreshold?: number
}

export interface InstallStatusRefreshRuntime {
  compareFontInstalled: (item: FontItem) => Promise<InstallCompareResult>
  compareFontsInstalled: (
    items: FontItem[],
    options?: InstallCompareOptions
  ) => Promise<Record<string, InstallCompareResult>>
  refreshInstallStatusIndex: (
    options?: InstallCompareOptions,
    runtime?: { jobId?: string; emitProgress?: boolean }
  ) => Promise<InstallStatusRefreshResult>
  readSystemInstalledFontsLightweight: () => Promise<SystemInstalledFont[]>
}

export const DEFAULT_REFRESH_BATCH_SIZE = Math.max(
  20,
  Math.min(
    1000,
    Number(process.env.HFM_INSTALL_STATUS_BATCH_SIZE || 500) || 500
  )
)

export const DEFAULT_LIGHTWEIGHT_MISSING_THRESHOLD = Math.max(
  1,
  Math.min(
    256,
    Number(process.env.HFM_INSTALL_STATUS_LIGHTWEIGHT_MISSING_THRESHOLD || 32) || 32
  )
)
