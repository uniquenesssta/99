import type { FontItem, LibraryState } from "../../../shared/types";
import { validatePreviewInput } from "./previewInputPolicy";
import { readCachedPreviewImageDataUris } from "./previewCachedImageReadBatchRuntime";
import type { PreviewCacheStorage, PreviewRuntimeOptions } from "./previewRuntimeTypes";
import type { PreviewCacheHydrationRow, createPreviewCacheHydrationRuntime } from "./previewCacheHydrationRuntime";
import type { createPreviewCachePrefetchRuntime } from "./previewCachePrefetchRuntime";
import type { createPreviewCacheRootAvailabilityRuntime } from "./previewCacheRootAvailabilityRuntime";
import type { createPreviewIndexAccessRuntime } from "./previewIndexAccessRuntime";
import type { createPreviewBatchRowsRuntime } from "./previewBatchRowsRuntime";
import type { createPreviewStorageIoRuntime } from "./previewStorageIoRuntime";

type BatchOptions = Pick<PreviewRuntimeOptions,
  | "appendStartupLog"
  | "normalizePathForCacheCompare"
  | "normalizePreviewCacheIndexStatus"
  | "previewSqliteSchemaVersion"
  | "runRustPreviewCacheBatch"
  | "runRustPreviewCacheQuery"
  | "runRustPreviewCacheTouch"
>;
type BatchPorts = {
  buildPreviewCacheGroups: ReturnType<typeof createPreviewBatchRowsRuntime>["buildPreviewCacheGroups"];
  loadLibraryShellCached: () => Promise<LibraryState>;
  withPreviewIndexDb: ReturnType<typeof createPreviewIndexAccessRuntime>["withPreviewIndexDb"];
  rustPreviewDbPathForStorage: ReturnType<typeof createPreviewStorageIoRuntime>["rustPreviewDbPathForStorage"];
  runStoragePreviewCacheIo: ReturnType<typeof createPreviewStorageIoRuntime>["runStoragePreviewCacheIo"];
  rootAvailability: Pick<ReturnType<typeof createPreviewCacheRootAvailabilityRuntime>, "ensureRootPreviewCacheAvailable" | "markRootPreviewCacheUnavailable">;
  hydrationRuntime: Pick<ReturnType<typeof createPreviewCacheHydrationRuntime>, "rememberLocalHit" | "rememberRenderQueued" | "hydratePreviewCacheRows">;
  prefetchRuntime: Pick<ReturnType<typeof createPreviewCachePrefetchRuntime>, "beginPreviewCachePrefetchGeneration" | "schedulePreviewCachePrefetch">;
};

export function createPreviewBatchReadRuntime(options: BatchOptions, ports: BatchPorts) {
  const { buildPreviewCacheGroups, loadLibraryShellCached, withPreviewIndexDb,
    rustPreviewDbPathForStorage, runStoragePreviewCacheIo, rootAvailability,
    hydrationRuntime, prefetchRuntime } = ports;
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

  async function getPreviewCacheStatus(
    items: FontItem[],
    text: string,
    fontSize = 34,
    width = 520,
    height = 150,
  ): Promise<Record<string, boolean>> {
    const { text: normalizedText } = validatePreviewInput({ text, fontSize, width, height }, options.appendStartupLog);
    const libraryShell = await loadLibraryShellCached();
    const result: Record<string, boolean> = {};
    prefetchRuntime.beginPreviewCachePrefetchGeneration("preview-cache-status");
    const groups = buildPreviewCacheGroups(
      items, libraryShell, normalizedText, fontSize, width, height,
      (id) => { result[id] = false; },
    );

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

      await withPreviewIndexDb(group.storage, async (db) => {
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
      });
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
    const { text: normalizedText } = validatePreviewInput({ text, fontSize, width, height }, options.appendStartupLog);
    const libraryShell = await loadLibraryShellCached();
    const result: Record<string, string> = {};
    const groups = buildPreviewCacheGroups(
      items, libraryShell, normalizedText, fontSize, width, height,
    );

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

      await withPreviewIndexDb(group.storage, async (db) => {
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
      });
    }

    return result;
  }

  return { getPreviewCacheStatus, readCachedPreviewImages };
}
