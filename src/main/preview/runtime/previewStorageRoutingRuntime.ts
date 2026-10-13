import { createPreviewSharedPreparationRuntime } from './previewSharedPreparationRuntime'
import { tracePreviewPhase } from './previewTraceRuntime'
import { sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { resolve } from "node:path";
import type { LibraryState } from "../../../shared/types";
import { findBestWatchedRootForFile } from "../../path/fontPathPolicy";
import type { PreviewCacheStorage, PreviewRuntimeOptions } from "./previewRuntimeTypes";
import type { createPreviewCacheRootAvailabilityRuntime } from "./previewCacheRootAvailabilityRuntime";
import type { createPreviewCacheTierRuntime } from "./previewCacheTierRuntime";

type RoutingOptions = Pick<PreviewRuntimeOptions,
  | "loadLibraryShell" | "cacheKeyForRootFile" | "cacheKeyForPath"
  | "rootPreviewCacheDir" | "rootPreviewImageDir" | "rootPreviewDbPath"
  | "localPreviewImageDir" | "hideDirectoryOnWindows"
  | "writeRootPreviewCacheManifest" | "appendStartupLog"
>;
type RoutingPorts = {
  rootAvailability: Pick<ReturnType<typeof createPreviewCacheRootAvailabilityRuntime>,
    "ensureRootPreviewCacheAvailable">;
  tierRuntime: Pick<ReturnType<typeof createPreviewCacheTierRuntime>,
    "localPreviewDirForRoot" | "localStorageForRoot" | "localStorageForPath">;
};

export function createPreviewStorageRoutingRuntime(options: RoutingOptions, ports: RoutingPorts) {
  const { rootAvailability, tierRuntime } = ports;
  const preparation = createPreviewSharedPreparationRuntime({ ...options, ensureRootAvailable: root => rootAvailability.ensureRootPreviewCacheAvailable(root) });
  let libraryShellCache: { value: LibraryState; expiresAt: number } | null =
    null;
  let libraryShellCachePromise: Promise<LibraryState> | null = null;
  let libraryShellGeneration = 0;

  async function loadLibraryShellCached(): Promise<LibraryState> {
    const now = Date.now();
    if (libraryShellCache && libraryShellCache.expiresAt > now)
      return libraryShellCache.value;
    if (libraryShellCachePromise) return libraryShellCachePromise;
    const taskGeneration = libraryShellGeneration;
    let task: Promise<LibraryState>;
    task = tracePreviewPhase('preview-library-context', () => options.loadLibraryShell())
      .then((value) => {
        if (taskGeneration === libraryShellGeneration)
          libraryShellCache = { value, expiresAt: Date.now() + 5000 };
        return value;
      })
      .finally(() => {
        if (libraryShellCachePromise === task) libraryShellCachePromise = null;
      });
    libraryShellCachePromise = task;
    return task;
  }

  function invalidateLibraryShellCache(): void {
    libraryShellGeneration += 1;
    preparation.invalidate();
    libraryShellCache = null;
    libraryShellCachePromise = null;
  }

  // Publication owns shared preparation. Local lookups never enter this path.
  const ensureSharedPreviewCachePrepared = preparation.ensurePrepared;

  async function previewCacheStorageForFont(
    fontPath: string,
    baseLibrary?: LibraryState,
  ): Promise<PreviewCacheStorage> {
    const resolvedFontPath = resolve(fontPath);

    try {
      const libraryFolders =
        baseLibrary?.folders || (await loadLibraryShellCached()).folders || [];
      const root = findBestWatchedRootForFile(resolvedFontPath, libraryFolders);

      if (root) {
        const identity = options.cacheKeyForRootFile(root, resolvedFontPath);
        await fsp.mkdir(tierRuntime.localPreviewDirForRoot(root), { recursive: true });
        return tierRuntime.localStorageForRoot(root, identity);
      }
    } catch (error) {
      options.appendStartupLog(
        `preview cache library lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const localPreviewDir = options.localPreviewImageDir();
    await fsp.mkdir(localPreviewDir, { recursive: true });
    return tierRuntime.localStorageForPath(
      options.cacheKeyForPath(resolvedFontPath),
    );
  }

  function previewCacheStorageForFontFromIndex(
    fontPath: string,
    baseLibrary: LibraryState,
  ): PreviewCacheStorage {
    const resolvedFontPath = resolve(fontPath);
    const root = findBestWatchedRootForFile(
      resolvedFontPath,
      baseLibrary.folders || [],
    );

    if (root) {
      const identity = options.cacheKeyForRootFile(root, resolvedFontPath);
      return tierRuntime.localStorageForRoot(root, identity);
    }

    return tierRuntime.localStorageForPath(
      options.cacheKeyForPath(resolvedFontPath),
    );
  }

  return {
    loadLibraryShellCached,
    ensureSharedPreviewCachePrepared,
    invalidateLibraryShellCache,
    previewCacheStorageForFont,
    previewCacheStorageForFontFromIndex,
  };
}
