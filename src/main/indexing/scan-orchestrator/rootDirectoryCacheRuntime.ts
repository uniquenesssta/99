import type fs from "node:fs";
import { promises as fsp } from "node:fs";
import { extname, join } from "node:path";
import type { ScanResult } from "../../../shared/types";
import {
  isIgnoredInternalDirectoryName,
  isRootIndexDbPath,
} from "../../cache/cachePaths";
import type { CachedFontStatLike } from "../../fonts/fontRuntime";
import {
  isOperationCancelledError,
  throwIfAborted,
} from "../../performance/ioQueue";
import { withIoDeadlineResult } from "../../path/ioDeadlineRuntime";
import type {
  RootDirectorySignature,
  RootScanCacheContext,
} from "../../watcher/watchedFolderIndexRuntime";
import type { ScanOrchestratorDeps } from "./scanOrchestratorTypes";
import {
  cacheKeyDirectlyInsideDirectory,
  cacheKeyInsideDirectory,
  relativeDirectoryPathForRoot,
} from "./scanOrchestratorUtils";

const DEFAULT_SCAN_FONT_STAT_TIMEOUT_MS = 1500;

function scanFontStatTimeoutMs(): number {
  const parsed = Number(
    process.env.HFM_SCAN_FONT_STAT_TIMEOUT_MS ||
      DEFAULT_SCAN_FONT_STAT_TIMEOUT_MS,
  );
  return Number.isFinite(parsed)
    ? Math.max(500, Math.min(10000, Math.floor(parsed)))
    : DEFAULT_SCAN_FONT_STAT_TIMEOUT_MS;
}

export interface RootDirectoryCacheRuntime {
  readRootDirectorySignatures: (
    context: RootScanCacheContext,
  ) => Promise<Map<string, RootDirectorySignature>>;
  saveRootDirectorySignatures: (context: RootScanCacheContext) => Promise<void>;
  relativeDirectoryPathForRoot: (rootPath: string, dirPath: string) => string;
  cacheKeyInsideDirectory: (cacheKey: string, relativeDir: string) => boolean;
  listFontFilesWithDirectoryCache: (
    context: RootScanCacheContext,
    errors: ScanResult["errors"],
    progress?: (payload: {
      files: number;
      foldersScanned: number;
      skippedDirs: number;
    }) => void,
    signal?: AbortSignal,
    startDir?: string,
    listedBatch?: (items: Array<{ file: string; rootPath: string; stat: CachedFontStatLike | null; error: string }>) => void,
  ) => Promise<
    Array<{
      file: string;
      rootPath: string;
      stat: CachedFontStatLike | null;
      error: string;
    }>
  >;
}

export function createRootDirectoryCacheRuntime(
  deps: ScanOrchestratorDeps,
): RootDirectoryCacheRuntime {
  async function readRootDirectorySignatures(
    context: RootScanCacheContext,
  ): Promise<Map<string, RootDirectorySignature>> {
    const signatures = new Map<string, RootDirectorySignature>();
    if (!isRootIndexDbPath(context.cachePath)) return signatures;
    const db = await deps.openRootIndexDb(
      context.cachePath,
      context.rootPath,
      context.storage,
      false,
    );
    try {
      for (const row of db
        .prepare(
          "SELECT relative_path, modified_at, file_count, dir_count FROM directories",
        )
        .all() as Array<{
        relative_path: string;
        modified_at: number;
        file_count: number;
        dir_count: number;
      }>) {
        signatures.set(row.relative_path || "", {
          modifiedAt: Number(row.modified_at || 0),
          fileCount: Number(row.file_count || 0),
          dirCount: Number(row.dir_count || 0),
        });
      }
    } catch (error) {
      deps.appendStartupLog(
        `directory signature read skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      deps.closeSqliteDb(db);
    }
    return signatures;
  }

  async function saveRootDirectorySignatures(
    context: RootScanCacheContext,
  ): Promise<void> {
    if (
      !context.directoryUpdates.length ||
      !isRootIndexDbPath(context.cachePath)
    )
      return;
    try {
      await deps.withRootCacheWriteLock(context.cachePath, async () => {
        const db = await deps.openRootIndexDb(
          context.cachePath,
          context.rootPath,
          context.storage,
          false,
        );
        const now = new Date().toISOString();
        try {
          const upsert = db.prepare(`
            INSERT INTO directories (relative_path, modified_at, file_count, dir_count, scanned_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(relative_path) DO UPDATE SET
              modified_at = excluded.modified_at,
              file_count = excluded.file_count,
              dir_count = excluded.dir_count,
              scanned_at = excluded.scanned_at
          `);
          const tx = db.transaction(() => {
            for (const item of context.directoryUpdates)
              upsert.run(
                item.relativePath,
                item.modifiedAt,
                item.fileCount,
                item.dirCount,
                now,
              );
          });
          tx();
        } finally {
          deps.closeSqliteDb(db);
        }
      });
    } catch (error) {
      deps.appendStartupLog(
        `directory signature write skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function cachedListedFilesForDirectDirectory(
    context: RootScanCacheContext,
    relativeDir: string,
  ): Array<{
    file: string;
    rootPath: string;
    stat: CachedFontStatLike;
    error: string;
  }> {
    const rows: Array<{
      file: string;
      rootPath: string;
      stat: CachedFontStatLike;
      error: string;
    }> = [];
    for (const [cacheKey, entry] of Object.entries(
      context.cache.entries || {},
    )) {
      if (!cacheKeyDirectlyInsideDirectory(cacheKey, relativeDir)) continue;
      if (entry.status !== "ok" && entry.status !== "bad") continue;
      context.seenKeys.add(cacheKey);
      rows.push({
        file: deps.cacheEntryRuntimePath(context.rootPath, cacheKey),
        rootPath: context.rootPath,
        stat: {
          size: entry.fileSize,
          mtimeMs: entry.modifiedAt,
          birthtimeMs: entry.createdAt,
          ctimeMs: entry.createdAt,
        },
        error: "",
      });
    }
    return rows;
  }

  function cachedListedFileForPath(
    context: RootScanCacheContext,
    filePath: string,
  ): {
    file: string;
    rootPath: string;
    stat: CachedFontStatLike;
    error: string;
  } | null {
    const normalizedKey = relativeDirectoryPathForRoot(
      context.rootPath,
      filePath,
    ).replace(/\\/g, "/");
    const entry = context.cache.entries[normalizedKey];
    if (!entry || (entry.status !== "ok" && entry.status !== "bad"))
      return null;
    context.seenKeys.add(normalizedKey);
    return {
      file: filePath,
      rootPath: context.rootPath,
      stat: {
        size: Number(entry.fileSize || 0),
        mtimeMs: Number(entry.modifiedAt || 0),
        birthtimeMs: Number(entry.createdAt || entry.modifiedAt || 0),
        ctimeMs: Number(entry.createdAt || entry.modifiedAt || 0),
      },
      error: "",
    };
  }

  async function listFontFilesWithDirectoryCache(
    context: RootScanCacheContext,
    errors: ScanResult["errors"],
    progress?: (payload: {
      files: number;
      foldersScanned: number;
      skippedDirs: number;
    }) => void,
    signal?: AbortSignal,
    startDir: string = context.rootPath,
    listedBatch?: (items: Array<{ file: string; rootPath: string; stat: CachedFontStatLike | null; error: string }>) => void,
  ): Promise<
    Array<{
      file: string;
      rootPath: string;
      stat: CachedFontStatLike | null;
      error: string;
    }>
  > {
    const signatures = await readRootDirectorySignatures(context);
    const files: Array<{
      file: string;
      rootPath: string;
      stat: CachedFontStatLike | null;
      error: string;
    }> = [];
    let foldersScanned = 0;
    let lastProgressAt = 0;

    const report = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastProgressAt < 300) return;
      lastProgressAt = now;
      progress?.({
        files: files.length,
        foldersScanned,
        skippedDirs: context.directorySkipped,
      });
    };

    async function walk(dir: string): Promise<void> {
      throwIfAborted(signal);
      let stat: fs.Stats;
      let entries: fs.Dirent[];
      try {
        stat = await deps.withGlobalIo("scan:stat-dir", () => fsp.stat(dir), {
          priority: "normal",
          signal,
          storagePath: dir,
        });
        entries = await deps.withGlobalIo(
          "scan:read-dir",
          () => fsp.readdir(dir, { withFileTypes: true }),
          {
            priority: "normal",
            signal,
            storagePath: dir,
          },
        );
      } catch (error) {
        if (isOperationCancelledError(error)) throw error;
        errors.push({
          path: dir,
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      foldersScanned += 1;
      const relativeDir = relativeDirectoryPathForRoot(context.rootPath, dir);
      let fileCount = 0;
      let dirCount = 0;
      const childDirectories: string[] = [];
      const fontFiles: string[] = [];
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (
            entry.name === "node_modules" ||
            entry.name.startsWith(".") ||
            isIgnoredInternalDirectoryName(entry.name)
          )
            continue;
          dirCount += 1;
          childDirectories.push(join(dir, entry.name));
        } else if (entry.isFile()) {
          fileCount += 1;
          if (
            !entry.name.startsWith("._") &&
            deps.fontExtensions.has(extname(entry.name).toLowerCase())
          ) {
            fontFiles.push(join(dir, entry.name));
          }
        }
      }

      const previous = signatures.get(relativeDir);
      const directoryUnchanged = Boolean(
        previous &&
        Math.round(previous.modifiedAt) === Math.round(stat.mtimeMs) &&
        previous.fileCount === fileCount &&
        previous.dirCount === dirCount,
      );
      const cachedDirect = directoryUnchanged
        ? cachedListedFilesForDirectDirectory(context, relativeDir)
        : [];
      const reusedDirectCache =
        directoryUnchanged && cachedDirect.length >= fontFiles.length;

      if (reusedDirectCache) {
        files.push(...cachedDirect);
        listedBatch?.(cachedDirect);
        context.directorySkipped += 1;
        report(false);
      } else {
        context.directoryUpdates.push({
          relativePath: relativeDir,
          modifiedAt: stat.mtimeMs,
          fileCount,
          dirCount,
        });
        report(false);

        const statTimeoutMs = scanFontStatTimeoutMs();
        for (const full of fontFiles) {
          throwIfAborted(signal);
          try {
            const fileStatResult = await deps.withGlobalIo(
              "scan:stat-font",
              () =>
                withIoDeadlineResult(
                  "scan:stat-font",
                  () => fsp.stat(full),
                  statTimeoutMs,
                ),
              {
                priority: "normal",
                signal,
                storagePath: full,
              },
            );
            if (!fileStatResult.ok) {
              const cached = cachedListedFileForPath(context, full);
              if (cached) {
                files.push(cached);
                listedBatch?.([cached]);
                if (fileStatResult.timedOut) context.directorySkipped += 1;
                report(false);
                continue;
              }
              if (fileStatResult.timedOut) {
                errors.push({
                  path: full,
                  message: `读取文件状态超过 ${statTimeoutMs}ms，已跳过并等待后续增量扫描补偿。`,
                });
                continue;
              }
              throw fileStatResult.error;
            }
            const fileStat = fileStatResult.value;
            const row = {
              file: full,
              rootPath: context.rootPath,
              stat: {
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs,
                birthtimeMs:
                  fileStat.birthtimeMs || fileStat.ctimeMs || fileStat.mtimeMs,
                ctimeMs: fileStat.ctimeMs || fileStat.mtimeMs,
              },
              error: "",
            };
            files.push(row);
            listedBatch?.([row]);
            report(false);
          } catch (error) {
            if (isOperationCancelledError(error)) throw error;
            errors.push({
              path: full,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      for (const full of childDirectories) {
        throwIfAborted(signal);
        await walk(full);
      }
    }

    throwIfAborted(signal);
    await walk(startDir);
    report(true);
    return files;
  }

  return {
    readRootDirectorySignatures,
    saveRootDirectorySignatures,
    relativeDirectoryPathForRoot,
    cacheKeyInsideDirectory,
    listFontFilesWithDirectoryCache,
  };
}
