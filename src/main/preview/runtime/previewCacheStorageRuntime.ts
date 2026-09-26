import { createPreviewBatchRowsRuntime } from "./previewBatchRowsRuntime";
import { createPreviewBatchReadRuntime } from "./previewBatchReadRuntime";
import { createPreviewStorageIoRuntime } from "./previewStorageIoRuntime";
import { createPreviewIndexAccessRuntime } from "./previewIndexAccessRuntime";
import type { FontItem, LibraryState } from "../../../shared/types";
import { createPreviewStorageRoutingRuntime } from "./previewStorageRoutingRuntime";
import {
  withIoDeadlineResult,
} from "../../path/ioDeadlineRuntime";
import type { PreviewCacheIndexStatus } from "../previewCacheRuntime";
import { createPreviewCacheRootAvailabilityRuntime } from "./previewCacheRootAvailabilityRuntime";
import { createPreviewCacheTierRuntime } from "./previewCacheTierRuntime";
import {
  createPreviewCacheHydrationRuntime,
  type PreviewCacheHydrationRow,
} from "./previewCacheHydrationRuntime";
import { createPreviewCachePrefetchRuntime } from "./previewCachePrefetchRuntime";
import { createPreviewLocalCacheEvictionRuntime } from "./previewLocalCacheEvictionRuntime";
import {
  createPreviewCacheSharedPresenceRuntime,
  type PreviewCacheSharedPresenceStatus,
} from "./previewCacheSharedPresenceRuntime";
import { createPreviewCacheSharedPresenceIndexRuntime } from "./previewCachePresenceIndexRuntime";
import { createPreviewCacheMetaRuntime } from "./previewCacheMetaRuntime";
import type {
  PreviewCacheStorage,
  PreviewRuntimeOptions,
} from "./previewRuntimeTypes";

export function createPreviewCacheStorageRuntime(
  options: PreviewRuntimeOptions,
): {
  previewCacheStorageForFont: (
    fontPath: string,
    baseLibrary?: LibraryState,
  ) => Promise<PreviewCacheStorage>;
  previewCacheStorageForFontFromIndex: (
    fontPath: string,
    baseLibrary: LibraryState,
  ) => PreviewCacheStorage;
  readPreviewCacheIndexStatus: (
    storage: PreviewCacheStorage,
    previewKey: string,
    outputPath: string,
  ) => Promise<PreviewCacheIndexStatus | null>;
  writePreviewCacheIndex: (
    storage: PreviewCacheStorage,
    previewKey: string,
    data: {
      outputPath: string;
      fontSignature: string;
      textHash: string;
      fontSize: number;
      width: number;
      height: number;
      status: PreviewCacheIndexStatus;
      message?: string;
      fontId?: string;
      sourcePath?: string;
    },
  ) => Promise<void>;
  deletePreviewCacheIndex: (
    storage: PreviewCacheStorage,
    previewKey: string,
  ) => Promise<void>;
  getPreviewCacheStatus: (
    items: FontItem[],
    text: string,
    fontSize?: number,
    width?: number,
    height?: number,
  ) => Promise<Record<string, boolean>>;
  readCachedPreviewImages: (
    items: FontItem[],
    text: string,
    fontSize?: number,
    width?: number,
    height?: number,
  ) => Promise<Record<string, string>>;
  hydratePreviewCache: (
    storage: PreviewCacheStorage,
    row: PreviewCacheHydrationRow,
  ) => Promise<boolean>;
  rememberPreviewCacheRenderQueued: (count?: number) => void;
  previewCacheStorageToShared: (
    storage: PreviewCacheStorage,
  ) => PreviewCacheStorage | null;
  ensureSharedPreviewCacheAvailable: (rootPath: string) => Promise<boolean>;
  invalidateLibraryShellCache: () => void;
} {
  const rootAvailability = createPreviewCacheRootAvailabilityRuntime({
    appendStartupLog: options.appendStartupLog,
  });
  const { rustPreviewDbPathForStorage, runRequiredRootPreviewCacheIo, runStoragePreviewCacheIo } =
    createPreviewStorageIoRuntime(options, rootAvailability);
  const tierRuntime = createPreviewCacheTierRuntime({
    localPreviewImageDir: options.localPreviewImageDir,
    rootPreviewImageDir: options.rootPreviewImageDir,
    rootPreviewDbPath: options.rootPreviewDbPath,
    sha1: options.sha1,
    normalizePathForCacheCompare: options.normalizePathForCacheCompare,
  });
  const sharedPresenceRuntime = createPreviewCacheSharedPresenceRuntime();
  const sharedPresenceIndexRuntime =
    createPreviewCacheSharedPresenceIndexRuntime({
      appendStartupLog: options.appendStartupLog,
      openPreviewDb: options.openPreviewDb,
    });
  const previewCacheMetaRuntime = createPreviewCacheMetaRuntime({
    appendStartupLog: options.appendStartupLog,
  });
  const evictionRuntime = createPreviewLocalCacheEvictionRuntime({
    appendStartupLog: options.appendStartupLog,
    localPreviewImageDir: options.localPreviewImageDir,
    openPreviewDb: options.openPreviewDb,
    normalizePathForCacheCompare: options.normalizePathForCacheCompare,
  });

  const {
    loadLibraryShellCached,
    ensureSharedPreviewCachePrepared,
    invalidateLibraryShellCache,
    previewCacheStorageForFont,
    previewCacheStorageForFontFromIndex,
  } = createPreviewStorageRoutingRuntime({
    loadLibraryShell: options.loadLibraryShell,
    cacheKeyForRootFile: options.cacheKeyForRootFile,
    cacheKeyForPath: options.cacheKeyForPath,
    rootPreviewCacheDir: options.rootPreviewCacheDir,
    rootPreviewImageDir: options.rootPreviewImageDir,
    rootPreviewDbPath: options.rootPreviewDbPath,
    localPreviewImageDir: options.localPreviewImageDir,
    hideDirectoryOnWindows: options.hideDirectoryOnWindows,
    writeRootPreviewCacheManifest: options.writeRootPreviewCacheManifest,
    appendStartupLog: options.appendStartupLog,
  }, { rootAvailability, tierRuntime, runRequiredRootPreviewCacheIo });

  async function rememberSharedPresence(
    storage: PreviewCacheStorage,
    previewKey: string,
    status: PreviewCacheSharedPresenceStatus,
  ): Promise<void> {
    if (storage.storage !== "root") return;
    sharedPresenceRuntime.rememberSharedPresence(storage, previewKey, status);
    await sharedPresenceIndexRuntime.rememberSharedPresenceIndex(
      storage,
      previewKey,
      status,
    );
  }

  async function forgetSharedPresence(
    storage: PreviewCacheStorage,
    previewKey: string,
  ): Promise<void> {
    if (storage.storage !== "root") return;
    sharedPresenceRuntime.forgetSharedPresence(storage, previewKey);
    await sharedPresenceIndexRuntime.forgetSharedPresenceIndex(
      storage,
      previewKey,
    );
  }

  const {
    readPreviewCacheIndexStatus,
    writePreviewCacheIndex,
    deletePreviewCacheIndex,
    withPreviewIndexDb,
  } = createPreviewIndexAccessRuntime(options, {
    rootAvailability, evictionRuntime, rustPreviewDbPathForStorage,
    runRequiredRootPreviewCacheIo, runStoragePreviewCacheIo,
    rememberSharedPresence, forgetSharedPresence,
  });

  const hydrationRuntime = createPreviewCacheHydrationRuntime({
    appendStartupLog: options.appendStartupLog,
    withIoDeadlineResult,
    readPreviewCacheIndexStatus,
    writePreviewCacheIndex,
    previewCacheStorageToShared: tierRuntime.previewCacheStorageToShared,
    ensureSharedAvailable: rootAvailability.ensureRootPreviewCacheAvailable,
    sharedPresence: sharedPresenceRuntime,
    sharedPresenceIndex: sharedPresenceIndexRuntime,
    validateSharedPreviewCacheMeta:
      previewCacheMetaRuntime.validatePreviewCacheMeta,
    isStrictSharedMetaEnabled:
      previewCacheMetaRuntime.isStrictSharedMetaEnabled,
  });

  const prefetchRuntime = createPreviewCachePrefetchRuntime({
    appendStartupLog: options.appendStartupLog,
    hydratePreviewCacheRows: hydrationRuntime.hydratePreviewCacheRows,
  });

  const { buildPreviewCacheGroups } = createPreviewBatchRowsRuntime(options, previewCacheStorageForFontFromIndex);
  const { getPreviewCacheStatus, readCachedPreviewImages } = createPreviewBatchReadRuntime(options, {
    buildPreviewCacheGroups, loadLibraryShellCached, withPreviewIndexDb,
    rustPreviewDbPathForStorage, runStoragePreviewCacheIo, rootAvailability,
    hydrationRuntime, prefetchRuntime,
  });

  return {
    previewCacheStorageForFont,
    previewCacheStorageForFontFromIndex,
    readPreviewCacheIndexStatus,
    writePreviewCacheIndex,
    deletePreviewCacheIndex,
    getPreviewCacheStatus,
    readCachedPreviewImages,
    hydratePreviewCache: hydrationRuntime.hydratePreviewCache,
    rememberPreviewCacheRenderQueued: hydrationRuntime.rememberRenderQueued,
    previewCacheStorageToShared: tierRuntime.previewCacheStorageToShared,
    ensureSharedPreviewCacheAvailable:
      ensureSharedPreviewCachePrepared,
    invalidateLibraryShellCache,
  };
}
