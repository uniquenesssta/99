import type {
FontIndexChangePayload,
FontIndexProgressPayload,
FontItem,
ScanResult,
} from "../../../shared/types";
import type { FontParseJob,FontParseWorkerResult,RustFontFamilyHint,RustFontNameHint,RustFontScriptHint,RustFontStyleHint } from "../../indexing/fontScanWorkers";
import type { FontScanCacheEntry,FontScanCacheFile } from "../../indexing/rootIndexRuntime";
import type { RootDirectorySignature,RootScanCacheContext } from "../watchedFolderIndexRuntime";

export type ManualFolderRefreshDeps = {
  fontExtensions: Set<string>;
  scriptDetectionVersion: number;
  fontScanCacheVersion: number;
  appendStartupLog: (message: string) => void;
  storageProfileForPath?: (filePath: string) => { isNetwork?: boolean; type?: string; reason?: string };
  withGlobalIo: <T>(
    name: string,
    task: () => Promise<T>,
    options?: any,
  ) => Promise<T>;
  fileCacheSignature: (cacheKey: string, size: number, modifiedAt: number) => string;
  cacheKeyForRootFile: (rootPath: string, filePath: string) => string;
  cacheEntryRuntimePath: (rootPath: string, cacheKey: string) => string;
  hasValidFontSignature: (filePath: string) => Promise<boolean>;
  fontItemFromPath: (filePath: string) => Promise<FontItem>;
  sanitizeCachedFont: (font: FontItem, cacheKey: string, filePath: string, stat: any) => FontItem;
  cachedFontForRuntime: (font: FontItem, filePath: string, stat: any, cacheKey: string) => FontItem;
  ensureRootScanCacheStorage: (rootPath: string) => Promise<{
    cachePath: string;
    cacheDir: string;
    storage: "root" | "fallback";
    cache: FontScanCacheFile;
  }>;
  saveRootIndexSqliteChanges: (
    cachePath: string,
    rootPath: string,
    storage: "root" | "fallback",
    changedEntries: Array<[string, FontScanCacheEntry]>,
    deletedKeys: string[],
  ) => Promise<void>;
  saveScanCacheFile: (
    cachePath: string,
    cache: FontScanCacheFile,
    rootPath: string,
    storage: "root" | "fallback",
  ) => Promise<void>;
  writeRootCacheManifest: (
    cacheDir: string,
    rootPath: string,
    storage: "root" | "fallback",
    total: number,
    cachePath: string,
  ) => Promise<void>;
  runFontParseWorkerPool: (
    jobs: FontParseJob[],
    onProgress?: (progress: { done: number; total: number; workerCount: number }) => void,
    signal?: AbortSignal,
    onResult?: (result: FontParseWorkerResult) => Promise<void>,
  ) => Promise<{ workerCount: number }>;
  runRustFontParseBatch?: (
    jobs: FontParseJob[],
    signal?: AbortSignal,
  ) => Promise<{
    results: FontParseJob[];
    errors?: Array<{ jobId?: string; path?: string; message?: string }>;
    count?: number;
    elapsedMs?: number;
  } | null>;
  runRustFontIndexListWorker?: (
    folders: string[],
    extensions: string[],
    progress: (payload: { files: number; foldersScanned: number }) => void,
    signal?: AbortSignal,
  ) => Promise<{
    files: Array<{ file: string; rootPath: string; stat: any; signatureValid?: boolean; format?: string; quickHash?: string; contentHash?: string; hashKind?: string; nameHint?: RustFontNameHint; scriptHint?: RustFontScriptHint; styleHint?: RustFontStyleHint; familyHint?: RustFontFamilyHint }>;
    directories?: Array<{ path: string; modifiedMs: number; fileCount: number; dirCount: number }>;
    errors: Array<{ path: string; message: string }>;
    foldersScanned?: number;
    truncated?: boolean;
    durationMs?: number;
  } | null>;
  scanWorkerCount: (fileCount: number, folders: string[]) => number;
  invalidateSharedFontRuntimeCaches: () => void;
  emitFontIndexProgress: (payload: FontIndexProgressPayload) => void;
  createFontScanJobId: () => string;
  delayToEventLoop: () => Promise<void>;
  rootIndexDbDir: (rootPath: string) => string;
  rootCacheLockDir: (rootPath: string) => string;
  rootCacheDir: (rootPath: string) => string;
  rootIndexDbPath: (rootPath: string) => string;
  resolveActiveRootIndexDbPath: (cacheDir: string, defaultDbPath: string) => Promise<string>;
  openRootIndexDb: (dbPath: string, rootPath: string, storage: "root" | "fallback", writable?: boolean) => Promise<any>;
  closeSqliteDb: (db: any) => void;
  sqliteQuickCheck: (db: any, label: string, dbPath: string, force?: boolean) => void;
  sqliteTableExists: (db: any, table: string) => boolean;
  quarantineSqliteFiles: (dbPath: string, label: string, message: string, quarantineDir?: string) => Promise<unknown>;
  recoveryMessage: (error: unknown) => string;
  sha1: (value: string) => string;
  hideDirectoryOnWindows: (dirPath: string) => Promise<void>;
  exists: (pathValue: string) => Promise<boolean>;
  initializeRootEventsDb: (db: any, rootPath: string) => void;
  initializeRootHashDb: (db: any, rootPath: string) => void;
  initializeRootMetricsDb: (db: any, rootPath: string) => void;
  rootEventsDbPath: (rootPath: string) => string;
  rootHashDbPath: (rootPath: string) => string;
  rootMetricsDbPath: (rootPath: string) => string;
  openStableSqliteDb: (dbPath: string, label: string) => any;
  initializePreviewDb: (db: any) => void;
  writeRootPreviewCacheManifest: (
    cacheDir: string,
    rootPath: string,
    storage: "root" | "fallback",
    dbPath: string,
    imageDir: string,
  ) => Promise<void>;
  rootPreviewCacheDir: (rootPath: string) => string;
  rootPreviewImageDir: (rootPath: string) => string;
  rootPreviewDbPath: (rootPath: string) => string;
  appWatchedFolders: () => Promise<string[]>;
  findBestWatchedRootForFile: (filePath: string, roots: string[]) => string | null;
  scanFoldersRuntime: () => {
    scanFoldersManaged: (folders: string[], knownFonts: FontItem[]) => Promise<ScanResult>;
    readRootDirectorySignatures: (context: RootScanCacheContext) => Promise<Map<string, RootDirectorySignature>>;
    saveRootDirectorySignatures: (context: RootScanCacheContext) => Promise<void>;
    listFontFilesWithDirectoryCache: (
      context: RootScanCacheContext,
      errors: ScanResult["errors"],
      progress?: (payload: { files: number; foldersScanned: number; skippedDirs: number }) => void,
      signal?: AbortSignal,
      startDir?: string,
      listedBatch?: (items: Array<{ file: string; rootPath: string; stat: any | null; error: string }>) => void,
    ) => Promise<Array<{ file: string; rootPath: string; stat: any | null; error: string }>>;
  };
  sendFontIndexChanged: (payload: FontIndexChangePayload) => void;
  syncMergedIndexForRootSnapshot: (rootPath: string, reason: string) => Promise<void>;
  syncMergedIndexForRootIncremental: (rootPath: string, payload: FontIndexChangePayload, reason: string) => Promise<void>;
  isRootIndexDbPath: (cachePath: string) => boolean;
};
