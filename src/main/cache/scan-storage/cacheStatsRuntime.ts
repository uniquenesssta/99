import type { Dirent } from "node:fs";
import { promises as fsp } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { CacheStats } from "../../../shared/types";
import type { FontScanCacheFile } from "../../indexing/rootIndexRuntime";
import { normalizePathForCacheCompare } from "../../path/cachePath";
import { isRootIndexDbPath, sqliteSidecarPaths } from "../cachePaths";
import type {
  RootIndexStorage,
  ScanCacheStorageRuntimeOptions,
} from "./scanCacheStorageTypes";

const DEFAULT_CACHE_STATS_TTL_MS = 10_000;
const DEFAULT_DIRECTORY_SIZE_TTL_MS = 300_000;
const DEFAULT_FILE_STATS_TTL_MS = 300_000;
const DIRECTORY_SIZE_CACHE_LIMIT = 128;
const FILE_STATS_CACHE_LIMIT = 512;

export function createCacheStatsRuntime(
  options: ScanCacheStorageRuntimeOptions,
  deps: {
    readScanCacheFile: (filePath: string) => Promise<FontScanCacheFile>;
  },
) {
  let cachedStats: { value: CacheStats; expiresAt: number } | null = null;
  const directorySizeCache = new Map<
    string,
    { value: number; expiresAt: number }
  >();
  const directorySizeInFlight = new Map<string, Promise<number>>();
  const fileStatsCache = new Map<
    string,
    { value: CacheStats; expiresAt: number }
  >();
  const fileStatsInFlight = new Map<string, Promise<CacheStats>>();

  async function readCacheStatsForFile(
    filePath: string,
    rootPath?: string,
    storage: RootIndexStorage = "root",
  ): Promise<CacheStats> {
    let sizeBytes = 0;
    for (const path of sqliteSidecarPaths(filePath)) {
      try {
        const stat = await fsp.stat(path);
        sizeBytes += stat.size;
      } catch {
        // ignore sidecar that does not exist
      }
    }

    if (isRootIndexDbPath(filePath)) {
      try {
        const cache = await options.readRootIndexSqliteFile(
          filePath,
          rootPath || dirname(dirname(filePath)),
          storage,
        );
        const values = Object.values(cache.entries);
        return {
          entries: values.length,
          goodEntries: values.filter((item) => item.status === "ok").length,
          badEntries: values.filter((item) => item.status === "bad").length,
          sizeBytes,
        };
      } catch {
        return { entries: 0, goodEntries: 0, badEntries: 0, sizeBytes };
      }
    }

    const cache = await deps.readScanCacheFile(filePath);
    const values = Object.values(cache.entries);
    return {
      entries: values.length,
      goodEntries: values.filter((item) => item.status === "ok").length,
      badEntries: values.filter((item) => item.status === "bad").length,
      sizeBytes,
    };
  }

  function rememberFileStats(filePath: string, value: CacheStats): CacheStats {
    const key = normalizePathForCacheCompare(filePath);
    fileStatsCache.set(key, {
      value: { ...value },
      expiresAt: Date.now() + DEFAULT_FILE_STATS_TTL_MS,
    });
    while (fileStatsCache.size > FILE_STATS_CACHE_LIMIT) {
      const oldest = fileStatsCache.keys().next().value;
      if (!oldest) break;
      fileStatsCache.delete(oldest);
    }
    return value;
  }

  function scheduleFileStatsRefresh(
    filePath: string,
    rootPath?: string,
    storage: RootIndexStorage = "root",
  ): void {
    const key = normalizePathForCacheCompare(filePath);
    if (fileStatsInFlight.has(key)) return;
    const task = readCacheStatsForFile(filePath, rootPath, storage)
      .then((value) => {
        rememberFileStats(filePath, value);
        cachedStats = null;
        return value;
      })
      .catch(() => ({
        entries: 0,
        goodEntries: 0,
        badEntries: 0,
        sizeBytes: 0,
      }))
      .finally(() => {
        fileStatsInFlight.delete(key);
      });
    fileStatsInFlight.set(key, task);
  }

  async function getCacheStatsForFile(
    filePath: string,
    rootPath?: string,
    storage: RootIndexStorage = "root",
  ): Promise<CacheStats> {
    const key = normalizePathForCacheCompare(filePath);
    const now = Date.now();
    const cached = fileStatsCache.get(key);
    if (cached && cached.expiresAt > now) return { ...cached.value };
    if (cached) {
      scheduleFileStatsRefresh(filePath, rootPath, storage);
      return { ...cached.value };
    }
    const inFlight = fileStatsInFlight.get(key);
    if (inFlight) return { ...(await inFlight) };
    const value = await readCacheStatsForFile(filePath, rootPath, storage);
    return { ...rememberFileStats(filePath, value) };
  }

  function addCacheStats(a: CacheStats, b: CacheStats): CacheStats {
    return {
      entries: a.entries + b.entries,
      goodEntries: a.goodEntries + b.goodEntries,
      badEntries: a.badEntries + b.badEntries,
      sizeBytes: a.sizeBytes + b.sizeBytes,
    };
  }

  async function directorySizeBytes(dirPath: string): Promise<number> {
    let total = 0;
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      return 0;
    }

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          total += await directorySizeBytes(fullPath);
        } else if (entry.isFile()) {
          total += (await fsp.stat(fullPath)).size;
        }
      } catch {
        // ignore disappearing cache files
      }
    }

    return total;
  }

  function rememberDirectorySize(dirPath: string, value: number): number {
    directorySizeCache.set(dirPath, {
      value,
      expiresAt: Date.now() + DEFAULT_DIRECTORY_SIZE_TTL_MS,
    });
    while (directorySizeCache.size > DIRECTORY_SIZE_CACHE_LIMIT) {
      const oldest = directorySizeCache.keys().next().value;
      if (!oldest) break;
      directorySizeCache.delete(oldest);
    }
    return value;
  }

  function scheduleDirectorySizeRefresh(dirPath: string): void {
    if (directorySizeInFlight.has(dirPath)) return;
    const task = directorySizeBytes(dirPath)
      .then((value) => {
        rememberDirectorySize(dirPath, value);
        cachedStats = null;
        return value;
      })
      .catch(() => 0)
      .finally(() => {
        directorySizeInFlight.delete(dirPath);
      });
    directorySizeInFlight.set(dirPath, task);
  }

  function cachedDirectorySizeBytes(dirPath: string): number {
    const now = Date.now();
    const cached = directorySizeCache.get(dirPath);
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached) {
      scheduleDirectorySizeRefresh(dirPath);
      return cached.value;
    }
    scheduleDirectorySizeRefresh(dirPath);
    return 0;
  }

  async function getPreviewIndexStats(dbPath: string): Promise<CacheStats> {
    let sizeBytes = 0;
    for (const filePath of sqliteSidecarPaths(dbPath)) {
      try {
        sizeBytes += (await fsp.stat(filePath)).size;
      } catch {
        // ignore
      }
    }

    if (!(await options.exists(dbPath)))
      return { entries: 0, goodEntries: 0, badEntries: 0, sizeBytes };

    const db = options.openStableSqliteDb(dbPath, "preview-stats");
    try {
      options.initializePreviewDb(db);
      const row = db
        .prepare(
          `
      SELECT
        COUNT(*) AS entries,
        SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS goodEntries,
        SUM(CASE WHEN status IN ('failed', 'missing', 'stale') THEN 1 ELSE 0 END) AS badEntries
      FROM preview_cache
    `,
        )
        .get() as
        | { entries?: number; goodEntries?: number; badEntries?: number }
        | undefined;
      return {
        entries: Number(row?.entries || 0),
        goodEntries: Number(row?.goodEntries || 0),
        badEntries: Number(row?.badEntries || 0),
        sizeBytes,
      };
    } catch {
      return { entries: 0, goodEntries: 0, badEntries: 0, sizeBytes };
    } finally {
      options.closeSqliteDb(db);
    }
  }

  async function getCacheStats(): Promise<CacheStats> {
    const now = Date.now();
    if (cachedStats && cachedStats.expiresAt > now)
      return { ...cachedStats.value };
    let stats: CacheStats = {
      entries: 0,
      goodEntries: 0,
      badEntries: 0,
      sizeBytes: 0,
    };
    const seenFiles = new Set<string>();

    async function include(filePath: string): Promise<void> {
      const key = normalizePathForCacheCompare(filePath);
      if (seenFiles.has(key)) return;
      seenFiles.add(key);
      stats = addCacheStats(stats, await getCacheStatsForFile(filePath));
    }

    await include(options.legacyScanCachePath());

    try {
      stats = addCacheStats(
        stats,
        await getPreviewIndexStats(options.previewSqlitePath()),
      );
      stats.sizeBytes += cachedDirectorySizeBytes(
        options.localPreviewImageDir(),
      );
    } catch {
      // ignore local preview cache stats
    }

    try {
      const library = await options.loadLibraryShell();
      for (const rawFolder of library.folders || []) {
        if (!rawFolder) continue;
        const folder = resolve(rawFolder);
        for (const dbPath of await options.listRootIndexDatabaseFiles(
          options.rootCacheDir(folder),
          options.rootIndexDbPath(folder),
        ))
          await include(dbPath);
        await include(options.rootScanCachePath(folder));
        await include(options.rootLegacyScanCachePath(folder));
        stats = addCacheStats(
          stats,
          await getPreviewIndexStats(options.rootPreviewDbPath(folder)),
        );
        stats.sizeBytes += cachedDirectorySizeBytes(
          options.rootPreviewImageDir(folder),
        );
        stats.sizeBytes += cachedDirectorySizeBytes(
          options.legacyRootPreviewCacheDir(folder),
        );
        for (const dbPath of await options.listRootIndexDatabaseFiles(
          options.fallbackCacheRootDir(folder),
          options.fallbackIndexDbPath(folder),
        ))
          await include(dbPath);
        await include(options.fallbackScanCachePath(folder));
        await include(options.fallbackLegacyScanCachePath(folder));
        stats = addCacheStats(
          stats,
          await getPreviewIndexStats(options.fallbackPreviewDbPath(folder)),
        );
        stats.sizeBytes += cachedDirectorySizeBytes(
          options.fallbackPreviewImageDir(folder),
        );
      }
    } catch {
      // ignore
    }

    cachedStats = {
      value: { ...stats },
      expiresAt: Date.now() + DEFAULT_CACHE_STATS_TTL_MS,
    };
    return stats;
  }

  return {
    getCacheStats,
    getPreviewIndexStats,
    directorySizeBytes,
    addCacheStats,
  };
}
