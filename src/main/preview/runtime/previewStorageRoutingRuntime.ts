import { sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { dirname, resolve } from "node:path";
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
    "ensureRootPreviewCacheAvailable" | "markRootPreviewCacheUnavailable">;
  tierRuntime: Pick<ReturnType<typeof createPreviewCacheTierRuntime>,
    "localPreviewDirForRoot" | "localStorageForRoot" | "localStorageForPath">;
  runRequiredRootPreviewCacheIo: <T>(rootPath: string, label: string, operation: () => Promise<T>) => Promise<T>;
};

export function createPreviewStorageRoutingRuntime(options: RoutingOptions, ports: RoutingPorts) {
  const { rootAvailability, tierRuntime, runRequiredRootPreviewCacheIo } = ports;
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
    task = options
      .loadLibraryShell()
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
    libraryShellCache = null;
    libraryShellCachePromise = null;
  }

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
        const previewCacheDir = options.rootPreviewCacheDir(root);
        const previewImageDir = options.rootPreviewImageDir(root);
        const previewDbPath = options.rootPreviewDbPath(root);
        const localPreviewDir = tierRuntime.localPreviewDirForRoot(root);

        try {
          if (!(await rootAvailability.ensureRootPreviewCacheAvailable(root)))
            throw new Error("共享预览缓存根目录暂不可达");
          await runRequiredRootPreviewCacheIo(
            root,
            `preview-cache-mkdir-images:${root}`,
            () => fsp.mkdir(previewImageDir, { recursive: true }),
          );
          await runRequiredRootPreviewCacheIo(
            root,
            `preview-cache-mkdir-db:${root}`,
            () => fsp.mkdir(dirname(previewDbPath), { recursive: true }),
          );
          await runRequiredRootPreviewCacheIo(
            root,
            `preview-cache-hide-dir:${root}`,
            () => options.hideDirectoryOnWindows(previewCacheDir),
          );
          await runRequiredRootPreviewCacheIo(
            root,
            `preview-cache-write-manifest:${root}`,
            () =>
              options.writeRootPreviewCacheManifest(
                previewCacheDir,
                root,
                "root",
                previewDbPath,
                previewImageDir,
              ),
          );
          await fsp.mkdir(localPreviewDir, { recursive: true });
          return tierRuntime.localStorageForRoot(root, identity);
        } catch (error) {
          rootAvailability.markRootPreviewCacheUnavailable(root, error);
          options.appendStartupLog(
            `preview cache shared tier unavailable, local tier will be used: ${root}, ${error instanceof Error ? error.message : String(error)}`,
          );
          await fsp
            .mkdir(localPreviewDir, { recursive: true })
            .catch(() => undefined);
          return tierRuntime.localStorageForRoot(root, identity);
        }
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
    invalidateLibraryShellCache,
    previewCacheStorageForFont,
    previewCacheStorageForFontFromIndex,
  };
}
