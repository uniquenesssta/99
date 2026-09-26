import { getStartupPathRootState } from '../../path/startupPathAvailabilityRuntime'
import { applicationWorkEpoch, isApplicationClosing } from '../../app/shutdownCoordinatorRuntime'
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
    preparations.clear();
    libraryShellCache = null;
    libraryShellCachePromise = null;
  }

  // Publication owns shared preparation. Local lookups never enter this path.
  const preparations = new Map<string, { generation: number; task: Promise<boolean> }>();
  async function ensureSharedPreviewCachePrepared(root: string): Promise<boolean> {
    if (isApplicationClosing()) return false;
    if (!(await rootAvailability.ensureRootPreviewCacheAvailable(root))) {
      preparations.delete(getStartupPathRootState(root).rootId);
      return false;
    }
    const state = getStartupPathRootState(root);
    const key = state.rootId;
    const previous = preparations.get(key);
    if (previous && previous.generation === state.generation)
      return previous.task;
    const shellGeneration = libraryShellGeneration;
    const epoch = applicationWorkEpoch();
    const current = () => !isApplicationClosing() && applicationWorkEpoch() === epoch
      && shellGeneration === libraryShellGeneration
      && getStartupPathRootState(root).generation === state.generation
      && getStartupPathRootState(root).rootId === state.rootId
      && getStartupPathRootState(root).state === 'online';
    const cacheDir = options.rootPreviewCacheDir(root);
    const imageDir = options.rootPreviewImageDir(root);
    const dbPath = options.rootPreviewDbPath(root);
    const entry = { generation: state.generation, task: Promise.resolve(false) };
    preparations.set(key, entry);
    entry.task = (async () => {
      try {
        for (const [label, operation] of [
          ['mkdir-images', () => fsp.mkdir(imageDir, { recursive: true })],
          ['mkdir-db', () => fsp.mkdir(dirname(dbPath), { recursive: true })],
          ['hide-dir', () => options.hideDirectoryOnWindows(cacheDir)],
          ['write-manifest', () => options.writeRootPreviewCacheManifest(cacheDir, root, 'root', dbPath, imageDir)],
        ] as Array<[string, () => Promise<unknown>]>) {
          if (!current()) return false;
          await runRequiredRootPreviewCacheIo(root, `preview-cache-${label}:${root}`, operation);
        }
        if (!current()) return false;
        // Reuse concurrent preparation only. Each publication checks directories again,
        // so deletion cannot leave a permanent prepared flag or skip manifest creation.
        return true;
      } catch (error) {
        if (current()) rootAvailability.markRootPreviewCacheUnavailable(root, error);
        options.appendStartupLog(`preview cache preparation failed: ${root}, ${String(error)}`);
        return false;
      } finally {
        if (preparations.get(key) === entry) preparations.delete(key);
      }
    })();
    return entry.task;
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
