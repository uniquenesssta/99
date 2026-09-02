import type {
FontActivationBatchResult,
FontItem,
InstallCompareResult,
SystemInstalledFont,
} from "../../../shared/types";
import type { GlobalIoOptions } from "../../performance/ioScheduler";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontResourceBatchResult } from "../../windows/runtime/fontRuntimeTypes";

export interface ActivationInstallStatusSnapshotResult {
  results: Record<string, InstallCompareResult>;
  misses: FontItem[];
}

export interface FontActivationRuntimeDeps {
  appName: string;
  dataPath: (name: string) => string;
  dataRoot: () => string;
  ensureWindows: () => void;
  currentUserFontsDir: () => string;
  normalizePathForCacheCompare: (filePath: string) => string;
  isTemporaryActiveInstalledRecord: (record: SystemInstalledFont) => boolean;
  compareFontInstalledWithList: (
    item: FontItem,
    installed: SystemInstalledFont[],
  ) => InstallCompareResult;
  clearInstalledFontsMemoryCache: () => void;
  getSystemInstalledFontsCached: (
    force?: boolean,
  ) => Promise<SystemInstalledFont[]>;
  readInstallStatusIndex: (
    items: FontItem[],
    options?: { enqueueMissTasks?: boolean },
  ) => Promise<ActivationInstallStatusSnapshotResult>;
  saveInstallStatusIndex: (
    results: Record<string, InstallCompareResult>,
    itemsById: Map<string, FontItem>,
  ) => Promise<void>;
  scheduleActivationInstallStatusSave: (
    results: Record<string, InstallCompareResult>,
    itemsById: Map<string, FontItem>,
    reason: string,
  ) => void;
  loadTemporaryActiveFonts: () => Promise<{
    version?: number;
    records: TemporaryActiveFontRecord[];
  }>;
  saveTemporaryActiveFonts: (state: {
    version: 1;
    records: TemporaryActiveFontRecord[];
  }) => Promise<void>;
  safeTemporaryActiveFontName: (item: FontItem) => string;
  temporaryActiveRegistryNameFor: (item: FontItem) => string;
  removeFontResourceSession: (fontPath: string) => Promise<unknown>;
  removeFontResourceSessionBatch: (
    fontPaths: string[],
  ) => Promise<FontResourceBatchResult>;
  addFontResourceSessionBatch: (
    fontPaths: string[],
    options?: { notify?: boolean; reason?: string },
  ) => Promise<Record<string, { ok: boolean; message?: string }>>;
  writeFontRegistryValuesHKCUBatch: (
    records: Array<{ name: string; path: string }>,
  ) => Promise<unknown>;
  deleteFontRegistryValuesHKCUBatch: (names: string[]) => Promise<unknown>;
  deleteRegistryValueHKCU: (name: string) => Promise<unknown>;
  requestFontRefresh: (
    reason: string,
    mode?: "light" | "standard" | "strong",
    options?: { delayMs?: number; force?: boolean },
  ) => void;
  advancedFontRefresh: (reason: string) => Promise<unknown> | unknown;
  addFontResourceSession: (
    fontPath: string,
    options?: { notify?: boolean; reason?: string },
  ) => Promise<unknown>;
  scheduleBackgroundFontRefreshTail: (reason: string, delayMs?: number) => void;
  withGlobalIo: <T>(
    label: string,
    task: () => Promise<T>,
    options?: GlobalIoOptions,
  ) => Promise<T>;
  delayToEventLoop: () => Promise<void>;
  appendStartupLog: (message: string) => void;
  runRustFontActivationFiles?: (input: {
    copies?: Array<{ id: string; source: string; dest: string }>;
    deletes?: string[];
    allowedDeleteDir?: string;
    allowedNamePrefix?: string;
  }) => Promise<{
    ok: boolean;
    copied: number;
    reused: number;
    deleted: number;
    failed: number;
    copyResults: Array<{ id: string; source: string; dest: string; ok: boolean; mode: string; message: string }>;
    deleteResults: Array<{ path: string; ok: boolean; message: string }>;
  } | null>;
}

export interface PreparedTemporaryActivation {
  item: FontItem;
  record: TemporaryActiveFontRecord;
  created: boolean;
}

export type FontActivationBatchResults = FontActivationBatchResult["results"];
