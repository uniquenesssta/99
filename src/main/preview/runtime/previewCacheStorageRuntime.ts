import { promises as fsp } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FontItem, LibraryState } from "../../../shared/types";
import { findBestWatchedRootForFile } from "../../path/fontPathPolicy";
import {
  previewCacheQueryTimeoutMs,
  withIoDeadlineResult,
} from "../../path/ioDeadlineRuntime";
import type { PreviewCacheIndexStatus } from "../previewCacheRuntime";
import {
  DEFAULT_PREVIEW_TEXT,
  previewCacheKey,
  previewCacheTextHash,
  previewFontSignature,
} from "./previewCacheKeyRuntime";
import { readCachedPreviewImageDataUris } from "./previewCachedImageReadBatchRuntime";
import { createPreviewCacheRootAvailabilityRuntime } from "./previewCacheRootAvailabilityRuntime";
import {
  previewCacheIdentityForInstalledRoute,
  previewCacheStatForInstalledRoute,
  resolveInstalledFontPreviewRoute,
} from "./previewInstalledFontRouteRuntime";
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
  let libraryShellCache: { value: LibraryState; expiresAt: number } | null =
    null;
  let libraryShellCachePromise: Promise<LibraryState> | null = null;
  let libraryShellGeneration = 0;
  const rootAvailability = createPreviewCacheRootAvailabilityRuntime({
    appendStartupLog: options.appendStartupLog,
  });
  const previewCacheIoTimeoutMs = previewCacheQueryTimeoutMs();
  const readStatusCache = new Map<
    string,
    { value: PreviewCacheIndexStatus | null; expiresAt: number }
  >();
  const readStatusInFlight = new Map<
    string,
    Promise<PreviewCacheIndexStatus | null>
  >();
  const readStatusGeneration = new Map<string, object>();
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

  function rustPreviewDbPathForStorage(
    storage: PreviewCacheStorage,
  ): string | null {
    // Local preview DB can stay open in the main process; keep it on Node to avoid cross-process SQLite lock churn.
    return storage.storage === "local" ? null : storage.indexDbPath || null;
  }

  function previewCacheIoErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function runRequiredRootPreviewCacheIo<T>(
    rootPath: string,
    label: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const result = await withIoDeadlineResult(
      label,
      operation,
      previewCacheIoTimeoutMs,
    );
    if (!result.ok) {
      rootAvailability.markRootPreviewCacheUnavailable(rootPath, result.error);
      throw result.error;
    }
    return result.value;
  }

  async function runOptionalRootPreviewCacheIo<T>(
    rootPath: string,
    label: string,
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const result = await withIoDeadlineResult(
      label,
      operation,
      previewCacheIoTimeoutMs,
    );
    if (!result.ok) {
      rootAvailability.markRootPreviewCacheUnavailable(rootPath, result.error);
      options.appendStartupLog(
        `preview cache io deadline dropped: ${label}, ${previewCacheIoErrorMessage(result.error)}`,
      );
      return { ok: false };
    }
    return { ok: true, value: result.value };
  }

  async function runStoragePreviewCacheIo<T>(
    storage: PreviewCacheStorage,
    label: string,
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    if (storage.storage === "root" && storage.rootPath)
      return runOptionalRootPreviewCacheIo(storage.rootPath, label, operation);
    return { ok: true, value: await operation() };
  }

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

  async function openPreviewIndexDb(
    storage: PreviewCacheStorage,
  ): Promise<{ db: any; close: boolean }> {
    if (storage.storage === "local" || !storage.indexDbPath)
      return { db: await options.openPreviewDb(), close: false };

    const indexDbPath = storage.indexDbPath;
    if (!indexDbPath)
      return { db: await options.openPreviewDb(), close: false };
    if (
      storage.rootPath &&
      !(await rootAvailability.ensureRootPreviewCacheAvailable(
        storage.rootPath,
      ))
    )
      throw new Error("共享预览缓存根目录暂不可达");
    await runRequiredRootPreviewCacheIo(
      storage.rootPath || "",
      `preview-cache-open-db-dir:${storage.rootPath || indexDbPath}`,
      () => fsp.mkdir(dirname(indexDbPath), { recursive: true }),
    );
    const db = options.openStableSqliteDb(
      indexDbPath,
      `preview:${storage.storage}`,
    );
    try {
      options.initializePreviewDb(db);
      return { db, close: true };
    } catch (error) {
      options.closeSqliteDb(db);
      if (storage.rootPath)
        rootAvailability.markRootPreviewCacheUnavailable(
          storage.rootPath,
          error,
        );
      throw error;
    }
  }

  function readStatusCacheKey(
    storage: PreviewCacheStorage,
    previewKey: string,
    outputPath: string,
  ): string {
    return [
      storage.indexDbPath || "local",
      previewKey,
      options.normalizePathForCacheCompare(outputPath),
    ].join("\0");
  }

  function readStatusToken(key: string): object {
    const existing = readStatusGeneration.get(key);
    if (existing) return existing;
    const token = {};
    readStatusGeneration.set(key, token);
    return token;
  }

  function invalidateReadStatusKey(key: string): void {
    const hadInFlight = readStatusInFlight.has(key);
    readStatusCache.delete(key);
    readStatusInFlight.delete(key);
    if (hadInFlight) readStatusGeneration.set(key, {});
    else readStatusGeneration.delete(key);
  }

  function forgetReadStatus(
    storage: PreviewCacheStorage,
    previewKey: string,
    outputPath?: string,
  ): void {
    if (outputPath) {
      invalidateReadStatusKey(
        readStatusCacheKey(storage, previewKey, outputPath),
      );
      return;
    }
    const prefix = `${storage.indexDbPath || "local"}\0${previewKey}\0`;
    const matchingKeys = new Set<string>();
    for (const key of readStatusCache.keys()) {
      if (key.startsWith(prefix)) matchingKeys.add(key);
    }
    for (const key of readStatusInFlight.keys()) {
      if (key.startsWith(prefix)) matchingKeys.add(key);
    }
    for (const key of readStatusGeneration.keys()) {
      if (key.startsWith(prefix)) matchingKeys.add(key);
    }
    for (const key of matchingKeys) invalidateReadStatusKey(key);
  }

  function rememberReadStatus(
    key: string,
    value: PreviewCacheIndexStatus | null,
  ): PreviewCacheIndexStatus | null {
    readStatusCache.set(key, { value, expiresAt: Date.now() + 1200 });
    while (readStatusCache.size > 512) {
      const oldest = readStatusCache.keys().next().value;
      if (!oldest) break;
      readStatusCache.delete(oldest);
    }
    return value;
  }

  async function readPreviewCacheIndexStatus(
    storage: PreviewCacheStorage,
    previewKey: string,
    outputPath: string,
  ): Promise<PreviewCacheIndexStatus | null> {
    const statusCacheKey = readStatusCacheKey(storage, previewKey, outputPath);
    const cachedStatus = readStatusCache.get(statusCacheKey);
    if (cachedStatus && cachedStatus.expiresAt > Date.now())
      return cachedStatus.value;
    const inFlightStatus = readStatusInFlight.get(statusCacheKey);
    if (inFlightStatus) return inFlightStatus;
    const taskGeneration = readStatusToken(statusCacheKey);
    let readTask: Promise<PreviewCacheIndexStatus | null>;
    readTask = readPreviewCacheIndexStatusUncached(
      storage,
      previewKey,
      outputPath,
    )
      .then((value) => {
        if (readStatusGeneration.get(statusCacheKey) !== taskGeneration)
          return value;
        return rememberReadStatus(statusCacheKey, value);
      })
      .finally(() => {
        if (readStatusInFlight.get(statusCacheKey) === readTask) {
          readStatusInFlight.delete(statusCacheKey);
          if (readStatusGeneration.get(statusCacheKey) === taskGeneration)
            readStatusGeneration.delete(statusCacheKey);
        } else if (!readStatusInFlight.has(statusCacheKey)) {
          readStatusGeneration.delete(statusCacheKey);
        }
      });
    readStatusInFlight.set(statusCacheKey, readTask);
    return readTask;
  }

  async function readPreviewCacheIndexStatusUncached(
    storage: PreviewCacheStorage,
    previewKey: string,
    outputPath: string,
  ): Promise<PreviewCacheIndexStatus | null> {
    if (
      storage.storage === "root" &&
      storage.rootPath &&
      !(await rootAvailability.ensureRootPreviewCacheAvailable(
        storage.rootPath,
      ))
    )
      return null;

    const rustDbPath = rustPreviewDbPathForStorage(storage);
    if (rustDbPath && options.runRustPreviewCacheReadStatus) {
      const readStatusResult = await runStoragePreviewCacheIo(
        storage,
        `preview-cache-read-status:${storage.rootPath || rustDbPath}`,
        () =>
          options.runRustPreviewCacheReadStatus!({
            dbPath: rustDbPath,
            schemaVersion: options.previewSqliteSchemaVersion,
            previewKey,
            outputPath,
            now: new Date().toISOString(),
          }),
      );
      if (!readStatusResult.ok) return null;
      if (readStatusResult.value) {
        const status = readStatusResult.value.status;
        if (status)
          await rememberSharedPresence(
            storage,
            previewKey,
            status === "ok" ? "ok" : "missing",
          );
        return status;
      }
    }

    const { db, close } = await openPreviewIndexDb(storage);
    try {
      const row = db
        .prepare(
          "SELECT output_path, status FROM preview_cache WHERE preview_key = ?",
        )
        .get(previewKey) as
        { output_path?: string; status?: string } | undefined;
      if (
        options.normalizePathForCacheCompare(row?.output_path || "") !==
        options.normalizePathForCacheCompare(outputPath)
      )
        return null;
      const status = options.normalizePreviewCacheIndexStatus(row?.status);
      if (status) {
        db.prepare(
          "UPDATE preview_cache SET accessed_at = ?, updated_at = ? WHERE preview_key = ?",
        ).run(new Date().toISOString(), new Date().toISOString(), previewKey);
        await rememberSharedPresence(
          storage,
          previewKey,
          status === "ok" ? "ok" : "missing",
        );
      }
      return status;
    } finally {
      if (close) options.closeSqliteDb(db);
    }
  }

  async function writePreviewCacheIndex(
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
  ): Promise<void> {
    forgetReadStatus(storage, previewKey, data.outputPath);
    if (
      storage.storage === "root" &&
      storage.rootPath &&
      !(await rootAvailability.ensureRootPreviewCacheAvailable(
        storage.rootPath,
      ))
    )
      return;

    const now = new Date().toISOString();
    const row = {
      preview_key: previewKey,
      font_id: data.fontId || null,
      source_path: data.sourcePath || null,
      root_path: storage.rootPath || null,
      relative_path: storage.identity,
      output_path: data.outputPath,
      font_signature: data.fontSignature,
      text_hash: data.textHash,
      font_size: data.fontSize,
      width: data.width,
      height: data.height,
      storage: storage.storage,
      status: data.status,
      message: data.message || null,
      fail_count: data.status === "failed" ? 1 : 0,
      generated_at: data.status === "ok" ? now : null,
      accessed_at: now,
      updated_at: now,
    };

    const rustDbPath = rustPreviewDbPathForStorage(storage);
    if (rustDbPath && options.runRustPreviewCacheApply) {
      const applyResult = await runStoragePreviewCacheIo(
        storage,
        `preview-cache-apply:${storage.rootPath || rustDbPath}`,
        () =>
          options.runRustPreviewCacheApply!({
            dbPath: rustDbPath,
            schemaVersion: options.previewSqliteSchemaVersion,
            rows: [row],
          }),
      );
      if (!applyResult.ok) return;
      if (applyResult.value) {
        await rememberSharedPresence(
          storage,
          previewKey,
          data.status === "ok" ? "ok" : "missing",
        );
        return;
      }
    }

    const { db, close } = await openPreviewIndexDb(storage);
    try {
      options.upsertPreviewCacheRows(db, [row]);
      await rememberSharedPresence(
        storage,
        previewKey,
        data.status === "ok" ? "ok" : "missing",
      );
      if (storage.storage === "local" && data.status === "ok")
        evictionRuntime.schedulePreviewLocalCacheEviction(
          "preview-cache-local-write",
        );
    } finally {
      if (close) options.closeSqliteDb(db);
    }
  }

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

  function schedulePrefetchForStatusMisses(
    storage: PreviewCacheStorage,
    rows: PreviewCacheHydrationRow[],
    statusMap: Record<string, boolean>,
  ): void {
    if (!storage.shared || !rows.length) return;
    const missRows = rows.filter((row) => !statusMap[row.id]);
    if (missRows.length)
      prefetchRuntime.schedulePreviewCachePrefetch(storage, missRows);
  }

  async function deletePreviewCacheIndex(
    storage: PreviewCacheStorage,
    previewKey: string,
  ): Promise<void> {
    forgetReadStatus(storage, previewKey);
    if (
      storage.storage === "root" &&
      storage.rootPath &&
      !(await rootAvailability.ensureRootPreviewCacheAvailable(
        storage.rootPath,
      ))
    )
      return;

    const rustDbPath = rustPreviewDbPathForStorage(storage);
    if (rustDbPath && options.runRustPreviewCacheDelete) {
      const deleteResult = await runStoragePreviewCacheIo(
        storage,
        `preview-cache-delete:${storage.rootPath || rustDbPath}`,
        () =>
          options.runRustPreviewCacheDelete!({
            dbPath: rustDbPath,
            schemaVersion: options.previewSqliteSchemaVersion,
            keys: [previewKey],
          }),
      );
      if (!deleteResult.ok) return;
      if (deleteResult.value) {
        await forgetSharedPresence(storage, previewKey);
        return;
      }
    }

    const { db, close } = await openPreviewIndexDb(storage);
    try {
      db.prepare("DELETE FROM preview_cache WHERE preview_key = ?").run(
        previewKey,
      );
      await forgetSharedPresence(storage, previewKey);
    } finally {
      if (close) options.closeSqliteDb(db);
    }
  }

  async function getPreviewCacheStatus(
    items: FontItem[],
    text: string,
    fontSize = 34,
    width = 520,
    height = 150,
  ): Promise<Record<string, boolean>> {
    const normalizedText = text || DEFAULT_PREVIEW_TEXT;
    const libraryShell = await loadLibraryShellCached();
    const groups = new Map<
      string,
      { storage: PreviewCacheStorage; rows: PreviewCacheHydrationRow[] }
    >();
    const result: Record<string, boolean> = {};
    prefetchRuntime.beginPreviewCachePrefetchGeneration("preview-cache-status");

    for (const item of items || []) {
      if (!item || !item.id || !item.path) {
        if (item?.id) result[item.id] = false;
        continue;
      }

      const storage = previewCacheStorageForFontFromIndex(
        item.path,
        libraryShell as unknown as LibraryState,
      );
      const installedRoute = resolveInstalledFontPreviewRoute(item);
      const stat = previewCacheStatForInstalledRoute(item, installedRoute);
      if (!stat) continue;
      const cacheIdentity = previewCacheIdentityForInstalledRoute(
        storage.identity,
        installedRoute,
      );
      const key = previewCacheKey(
        options.sha1,
        cacheIdentity,
        stat.size,
        stat.mtimeMs,
        fontSize,
        width,
        height,
        normalizedText,
      );
      const outputPath = join(storage.dir, `${key}.png`);
      const dbKey =
        storage.storage === "local"
          ? options.normalizePathForCacheCompare(storage.dir)
          : options.normalizePathForCacheCompare(
              storage.indexDbPath || storage.dir,
            );
      if (!groups.has(dbKey)) groups.set(dbKey, { storage, rows: [] });
      groups.get(dbKey)!.rows.push({
        id: item.id,
        previewKey: key,
        outputPath,
        fontSignature: previewFontSignature(
          cacheIdentity,
          stat.size,
          stat.mtimeMs,
        ),
        textHash: previewCacheTextHash(options.sha1, normalizedText),
        fontSize,
        width,
        height,
        fontId: item.id,
        sourcePath: item.path,
      });
    }

    const now = new Date().toISOString();
    const chunkSize = 400;
    for (const group of groups.values()) {
      if (
        group.storage.storage === "root" &&
        group.storage.rootPath &&
        !(await rootAvailability.ensureRootPreviewCacheAvailable(
          group.storage.rootPath,
        ))
      ) {
        for (const row of group.rows) result[row.id] = false;
        continue;
      }

      const rustDbPath = rustPreviewDbPathForStorage(group.storage);
      if (rustDbPath && options.runRustPreviewCacheBatch) {
        const batchResult = await runStoragePreviewCacheIo(
          group.storage,
          `preview-cache-batch:${group.storage.rootPath || rustDbPath}`,
          () =>
            options.runRustPreviewCacheBatch!({
              dbPath: rustDbPath,
              schemaVersion: options.previewSqliteSchemaVersion,
              rows: group.rows,
              acceptedStatuses: ["ok", "missing", "failed"],
              touchMatched: true,
              checkFiles: false,
              now,
            }),
        );
        if (!batchResult.ok) {
          for (const row of group.rows) result[row.id] = false;
          continue;
        }
        const rustResult = batchResult.value;
        if (rustResult) {
          const groupStatus: Record<string, boolean> = {};
          for (const row of rustResult.rows) {
            const matched = Boolean(row.matched);
            result[row.id] = matched;
            groupStatus[row.id] = matched;
          }
          schedulePrefetchForStatusMisses(
            group.storage,
            group.rows,
            groupStatus,
          );
          continue;
        }
      }

      if (rustDbPath && options.runRustPreviewCacheQuery) {
        const queryResult = await runStoragePreviewCacheIo(
          group.storage,
          `preview-cache-query:${group.storage.rootPath || rustDbPath}`,
          () =>
            options.runRustPreviewCacheQuery!({
              dbPath: rustDbPath,
              schemaVersion: options.previewSqliteSchemaVersion,
              rows: group.rows,
              acceptedStatuses: ["ok", "missing", "failed"],
              touchMatched: true,
              now,
            }),
        );
        if (!queryResult.ok) {
          for (const row of group.rows) result[row.id] = false;
          continue;
        }
        const rustResult = queryResult.value;
        if (rustResult) {
          const groupStatus: Record<string, boolean> = {};
          for (const row of rustResult.rows) {
            const matched = Boolean(row.matched);
            result[row.id] = matched;
            groupStatus[row.id] = matched;
          }
          schedulePrefetchForStatusMisses(
            group.storage,
            group.rows,
            groupStatus,
          );
          continue;
        }
      }

      const { db, close } = await openPreviewIndexDb(group.storage);
      try {
        const touchKeys: string[] = [];
        const groupStatus: Record<string, boolean> = {};
        for (let index = 0; index < group.rows.length; index += chunkSize) {
          const chunk = group.rows.slice(index, index + chunkSize);
          const keys = chunk.map((row) => row.previewKey);
          const placeholders = keys.map(() => "?").join(",");
          const cacheRows = placeholders
            ? (db
                .prepare(
                  `SELECT preview_key, output_path, status FROM preview_cache WHERE preview_key IN (${placeholders})`,
                )
                .all(...keys) as Array<{
                preview_key: string;
                output_path?: string;
                status?: string;
              }>)
            : [];
          const cacheByKey = new Map(
            cacheRows.map((row) => [row.preview_key, row]),
          );

          for (const rowInfo of chunk) {
            const row = cacheByKey.get(rowInfo.previewKey);
            const status = options.normalizePreviewCacheIndexStatus(
              row?.status,
            );
            const processedStatus =
              status === "ok" || status === "missing" || status === "failed";
            const matched =
              processedStatus &&
              options.normalizePathForCacheCompare(row?.output_path || "") ===
                options.normalizePathForCacheCompare(rowInfo.outputPath);
            result[rowInfo.id] = !!matched;
            groupStatus[rowInfo.id] = !!matched;
            if (matched) touchKeys.push(rowInfo.previewKey);
          }
        }

        for (let index = 0; index < touchKeys.length; index += chunkSize) {
          const keys = touchKeys.slice(index, index + chunkSize);
          const placeholders = keys.map(() => "?").join(",");
          if (placeholders)
            db.prepare(
              `UPDATE preview_cache SET accessed_at = ?, updated_at = ? WHERE preview_key IN (${placeholders})`,
            ).run(now, now, ...keys);
        }
        schedulePrefetchForStatusMisses(group.storage, group.rows, groupStatus);
      } finally {
        if (close) options.closeSqliteDb(db);
      }
    }

    return result;
  }

  async function readCachedPreviewImages(
    items: FontItem[],
    text: string,
    fontSize = 34,
    width = 520,
    height = 150,
  ): Promise<Record<string, string>> {
    const normalizedText = text || DEFAULT_PREVIEW_TEXT;
    const libraryShell = await loadLibraryShellCached();
    const groups = new Map<
      string,
      { storage: PreviewCacheStorage; rows: PreviewCacheHydrationRow[] }
    >();
    const result: Record<string, string> = {};

    for (const item of items || []) {
      if (!item || !item.id || !item.path) continue;

      const storage = previewCacheStorageForFontFromIndex(
        item.path,
        libraryShell as unknown as LibraryState,
      );
      const installedRoute = resolveInstalledFontPreviewRoute(item);
      const stat = previewCacheStatForInstalledRoute(item, installedRoute);
      if (!stat) continue;
      const cacheIdentity = previewCacheIdentityForInstalledRoute(
        storage.identity,
        installedRoute,
      );
      const key = previewCacheKey(
        options.sha1,
        cacheIdentity,
        stat.size,
        stat.mtimeMs,
        fontSize,
        width,
        height,
        normalizedText,
      );
      const outputPath = join(storage.dir, `${key}.png`);
      const dbKey =
        storage.storage === "local"
          ? options.normalizePathForCacheCompare(storage.dir)
          : options.normalizePathForCacheCompare(
              storage.indexDbPath || storage.dir,
            );
      if (!groups.has(dbKey)) groups.set(dbKey, { storage, rows: [] });
      groups.get(dbKey)!.rows.push({
        id: item.id,
        previewKey: key,
        outputPath,
        fontSignature: previewFontSignature(
          cacheIdentity,
          stat.size,
          stat.mtimeMs,
        ),
        textHash: previewCacheTextHash(options.sha1, normalizedText),
        fontSize,
        width,
        height,
        fontId: item.id,
        sourcePath: item.path,
      });
    }

    const now = new Date().toISOString();
    const chunkSize = 400;
    for (const group of groups.values()) {
      if (
        group.storage.storage === "root" &&
        group.storage.rootPath &&
        !(await rootAvailability.ensureRootPreviewCacheAvailable(
          group.storage.rootPath,
        ))
      ) {
        continue;
      }

      const rustDbPath = rustPreviewDbPathForStorage(group.storage);
      if (rustDbPath && options.runRustPreviewCacheBatch) {
        const batchResult = await runStoragePreviewCacheIo(
          group.storage,
          `preview-cache-batch:${group.storage.rootPath || rustDbPath}`,
          () =>
            options.runRustPreviewCacheBatch!({
              dbPath: rustDbPath,
              schemaVersion: options.previewSqliteSchemaVersion,
              rows: group.rows,
              acceptedStatuses: ["ok"],
              touchMatched: true,
              checkFiles: true,
              now,
            }),
        );
        if (!batchResult.ok) continue;
        const rustResult = batchResult.value;
        if (rustResult) {
          Object.assign(
            result,
            await readCachedPreviewImageDataUris(
              rustResult.rows
                .filter((rowInfo) => rowInfo.matched && rowInfo.status === "ok")
                .map((rowInfo) => ({
                  id: rowInfo.id,
                  outputPath: rowInfo.outputPath,
                })),
              6,
              {
                onReadTimeout: (item, error) => {
                  if (group.storage.rootPath)
                    rootAvailability.markRootPreviewCacheUnavailable(
                      group.storage.rootPath,
                      error,
                    );
                  options.appendStartupLog(
                    `preview cache image read deadline dropped: ${item.outputPath}`,
                  );
                },
              },
            ),
          );
          continue;
        }
      }

      if (rustDbPath && options.runRustPreviewCacheQuery) {
        const queryResult = await runStoragePreviewCacheIo(
          group.storage,
          `preview-cache-query:${group.storage.rootPath || rustDbPath}`,
          () =>
            options.runRustPreviewCacheQuery!({
              dbPath: rustDbPath,
              schemaVersion: options.previewSqliteSchemaVersion,
              rows: group.rows,
              acceptedStatuses: ["ok"],
              touchMatched: false,
              now,
            }),
        );
        if (!queryResult.ok) continue;
        const rustResult = queryResult.value;
        if (rustResult) {
          const matchedRows = rustResult.rows.filter(
            (rowInfo) => rowInfo.matched && rowInfo.status === "ok",
          );
          const imageDataUris = await readCachedPreviewImageDataUris(
            matchedRows.map((rowInfo) => ({
              id: rowInfo.id,
              outputPath: rowInfo.outputPath,
            })),
            6,
            {
              onReadTimeout: (item, error) => {
                if (group.storage.rootPath)
                  rootAvailability.markRootPreviewCacheUnavailable(
                    group.storage.rootPath,
                    error,
                  );
                options.appendStartupLog(
                  `preview cache image read deadline dropped: ${item.outputPath}`,
                );
              },
            },
          );
          Object.assign(result, imageDataUris);
          const touchKeys = matchedRows
            .filter((rowInfo) => imageDataUris[rowInfo.id])
            .map((rowInfo) => rowInfo.previewKey);
          if (touchKeys.length && options.runRustPreviewCacheTouch) {
            const touchResult = await runStoragePreviewCacheIo(
              group.storage,
              `preview-cache-touch:${group.storage.rootPath || rustDbPath}`,
              () =>
                options.runRustPreviewCacheTouch!({
                  dbPath: rustDbPath,
                  schemaVersion: options.previewSqliteSchemaVersion,
                  keys: touchKeys,
                  now,
                }),
            );
            if (!touchResult.ok) continue;
          }
          continue;
        }
      }

      const { db, close } = await openPreviewIndexDb(group.storage);
      try {
        const touchKeys: string[] = [];
        for (let index = 0; index < group.rows.length; index += chunkSize) {
          const chunk = group.rows.slice(index, index + chunkSize);
          const keys = chunk.map((row) => row.previewKey);
          const placeholders = keys.map(() => "?").join(",");
          const cacheRows = placeholders
            ? (db
                .prepare(
                  `SELECT preview_key, output_path, status FROM preview_cache WHERE preview_key IN (${placeholders})`,
                )
                .all(...keys) as Array<{
                preview_key: string;
                output_path?: string;
                status?: string;
              }>)
            : [];
          const cacheByKey = new Map(
            cacheRows.map((row) => [row.preview_key, row]),
          );
          const rowsToRead = chunk.filter((rowInfo) => {
            const row = cacheByKey.get(rowInfo.previewKey);
            const status = options.normalizePreviewCacheIndexStatus(
              row?.status,
            );
            return (
              status === "ok" &&
              options.normalizePathForCacheCompare(row?.output_path || "") ===
                options.normalizePathForCacheCompare(rowInfo.outputPath)
            );
          });
          const imageDataUris = await readCachedPreviewImageDataUris(
            rowsToRead,
            6,
            {
              onReadTimeout: (item, error) => {
                if (group.storage.rootPath)
                  rootAvailability.markRootPreviewCacheUnavailable(
                    group.storage.rootPath,
                    error,
                  );
                options.appendStartupLog(
                  `preview cache image read deadline dropped: ${item.outputPath}`,
                );
              },
            },
          );

          Object.assign(result, imageDataUris);
          hydrationRuntime.rememberLocalHit(Object.keys(imageDataUris).length);
          for (const rowInfo of rowsToRead) {
            if (imageDataUris[rowInfo.id]) touchKeys.push(rowInfo.previewKey);
          }

          const localMissRows = chunk.filter(
            (rowInfo) => !imageDataUris[rowInfo.id],
          );
          if (localMissRows.length && group.storage.shared) {
            const hydratedIds = await hydrationRuntime.hydratePreviewCacheRows(
              group.storage,
              localMissRows,
            );
            if (hydratedIds.size) {
              const hydratedRows = localMissRows.filter((rowInfo) =>
                hydratedIds.has(rowInfo.id),
              );
              const hydratedImageDataUris =
                await readCachedPreviewImageDataUris(hydratedRows, 6);
              Object.assign(result, hydratedImageDataUris);
              hydrationRuntime.rememberLocalHit(
                Object.keys(hydratedImageDataUris).length,
              );
              for (const rowInfo of hydratedRows) {
                if (hydratedImageDataUris[rowInfo.id])
                  touchKeys.push(rowInfo.previewKey);
              }
            }
          }
          const unresolvedCount = chunk.filter(
            (rowInfo) => !result[rowInfo.id],
          ).length;
          if (unresolvedCount)
            hydrationRuntime.rememberRenderQueued(unresolvedCount);
        }

        for (let index = 0; index < touchKeys.length; index += chunkSize) {
          const keys = touchKeys.slice(index, index + chunkSize);
          const placeholders = keys.map(() => "?").join(",");
          if (placeholders)
            db.prepare(
              `UPDATE preview_cache SET accessed_at = ?, updated_at = ? WHERE preview_key IN (${placeholders})`,
            ).run(now, now, ...keys);
        }
      } finally {
        if (close) options.closeSqliteDb(db);
      }
    }

    return result;
  }

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
      rootAvailability.ensureRootPreviewCacheAvailable,
    invalidateLibraryShellCache,
  };
}
