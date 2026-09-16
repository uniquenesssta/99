import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import type { PreviewCacheIndexStatus } from "../previewCacheRuntime";
import type { PreviewCacheStorage, PreviewRuntimeOptions } from "./previewRuntimeTypes";
import type { createPreviewCacheRootAvailabilityRuntime } from "./previewCacheRootAvailabilityRuntime";
import type { createPreviewLocalCacheEvictionRuntime } from "./previewLocalCacheEvictionRuntime";
import type { PreviewCacheSharedPresenceStatus } from "./previewCacheSharedPresenceRuntime";

type IndexOptions = Pick<PreviewRuntimeOptions,
  | "closeSqliteDb"
  | "initializePreviewDb"
  | "normalizePathForCacheCompare"
  | "normalizePreviewCacheIndexStatus"
  | "openPreviewDb"
  | "openStableSqliteDb"
  | "previewSqliteSchemaVersion"
  | "runRustPreviewCacheApply"
  | "runRustPreviewCacheDelete"
  | "runRustPreviewCacheReadStatus"
  | "upsertPreviewCacheRows"
>;
type IndexPorts = {
  rootAvailability: Pick<ReturnType<typeof createPreviewCacheRootAvailabilityRuntime>,
    "ensureRootPreviewCacheAvailable" | "markRootPreviewCacheUnavailable">;
  evictionRuntime: Pick<ReturnType<typeof createPreviewLocalCacheEvictionRuntime>, "schedulePreviewLocalCacheEviction">;
  rustPreviewDbPathForStorage: (storage: PreviewCacheStorage) => string | null;
  runRequiredRootPreviewCacheIo: <T>(rootPath: string, label: string, operation: () => Promise<T>) => Promise<T>;
  runStoragePreviewCacheIo: <T>(storage: PreviewCacheStorage, label: string, operation: () => Promise<T>) => Promise<{ ok: true; value: T } | { ok: false }>;
  rememberSharedPresence: (storage: PreviewCacheStorage, previewKey: string, status: PreviewCacheSharedPresenceStatus) => Promise<void>;
  forgetSharedPresence: (storage: PreviewCacheStorage, previewKey: string) => Promise<void>;
};

export function createPreviewIndexAccessRuntime(options: IndexOptions, ports: IndexPorts) {
  const { rootAvailability, evictionRuntime, rustPreviewDbPathForStorage,
    runRequiredRootPreviewCacheIo, runStoragePreviewCacheIo,
    rememberSharedPresence, forgetSharedPresence } = ports;
  const readStatusCache = new Map<
    string,
    { value: PreviewCacheIndexStatus | null; expiresAt: number }
  >();
  const readStatusInFlight = new Map<
    string,
    Promise<PreviewCacheIndexStatus | null>
  >();
  const readStatusGeneration = new Map<string, object>();

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
    forgetReadStatus(storage, previewKey);
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
        async () => {
          try {
            return await options.runRustPreviewCacheApply!({
              dbPath: rustDbPath,
              schemaVersion: options.previewSqliteSchemaVersion,
              rows: [row],
            });
          } finally {
            // A deadline does not cancel the worker; invalidate at actual settlement.
            forgetReadStatus(storage, previewKey);
          }
        },
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
      try {
        options.upsertPreviewCacheRows(db, [row]);
      } finally {
        forgetReadStatus(storage, previewKey);
      }
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
        async () => {
          try {
            return await options.runRustPreviewCacheDelete!({
              dbPath: rustDbPath,
              schemaVersion: options.previewSqliteSchemaVersion,
              keys: [previewKey],
            });
          } finally {
            // A deadline does not cancel the worker; invalidate at actual settlement.
            forgetReadStatus(storage, previewKey);
          }
        },
      );
      if (!deleteResult.ok) return;
      if (deleteResult.value) {
        await forgetSharedPresence(storage, previewKey);
        return;
      }
    }

    const { db, close } = await openPreviewIndexDb(storage);
    try {
      try {
        db.prepare("DELETE FROM preview_cache WHERE preview_key = ?").run(
          previewKey,
        );
      } finally {
        forgetReadStatus(storage, previewKey);
      }
      await forgetSharedPresence(storage, previewKey);
    } finally {
      if (close) options.closeSqliteDb(db);
    }
  }

  async function withPreviewIndexDb<T>(
    storage: PreviewCacheStorage,
    operation: (db: Awaited<ReturnType<PreviewRuntimeOptions["openPreviewDb"]>>) => Promise<T>,
  ): Promise<T> {
    const { db, close } = await openPreviewIndexDb(storage);
    try {
      return await operation(db);
    } finally {
      if (close) options.closeSqliteDb(db);
    }
  }

  return {
    readPreviewCacheIndexStatus,
    writePreviewCacheIndex,
    deletePreviewCacheIndex,
    withPreviewIndexDb,
  };
}
