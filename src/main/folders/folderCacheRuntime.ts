import { promises as fsp } from "node:fs";
import { resolve } from "node:path";
import type { FontItem,ScanResult } from "../../shared/types";
import { isRootIndexDbPath } from "../cache/cachePaths";
import type { FontScanCacheFile } from "../indexing/rootIndexRuntime";
import { createSharedIndexTrustRuntime } from "../indexing/root-index/sharedIndexTrustRuntime";
import { normalizePathForCacheCompare } from "../path/cachePath";
import { normalizeWatchedFontFolders } from "../path/fontPathPolicy";
import { filterFolderCacheAvailableRoots } from "./folderCacheRootAvailabilityRuntime";
import { createFolderCacheJsonRuntime } from "./folderCacheJsonRuntime";
import type { FolderCacheRuntimeDeps,FolderCacheSource,SharedFontsMemoryCache } from "./folderCacheTypes";
import { sharedFontsFoldersKey } from "./sharedFontsFoldersKeyRuntime";

export function createFolderCacheRuntime(deps: FolderCacheRuntimeDeps) {
  let sharedFontsMemoryCache: SharedFontsMemoryCache | null = null;
  const { readExistingScanCacheFile } = createFolderCacheJsonRuntime(deps);
  const sharedIndexTrustRuntime = createSharedIndexTrustRuntime({
    fontScanCacheVersion: deps.fontScanCacheVersion,
    exists: deps.exists,
    rootCacheDir: deps.rootCacheDir,
    rootIndexDbPath: deps.rootIndexDbPath,
    resolveActiveRootIndexDbPath: deps.resolveActiveRootIndexDbPath,
    appendStartupLog: deps.appendStartupLog,
  });

  async function tryReadRootIndexCache(
    rootPath: string,
    cachePath: string,
    storage: "root" | "fallback",
    options: { applySharedMetadataOverlay?: boolean } = {},
  ): Promise<FolderCacheSource | null> {
    if (!(await deps.exists(cachePath))) return null;
    try {
      return {
        cache: storage === "root" && options.applySharedMetadataOverlay !== false
          ? await deps.applySharedMetadataOverlay(
              rootPath,
              await deps.readRootIndexSqliteFile(cachePath, rootPath, storage),
            )
          : await deps.readRootIndexSqliteFile(cachePath, rootPath, storage),
        cachePath,
        storage,
      };
    } catch (error) {
      deps.appendStartupLog(
        `folder cache candidate skipped: storage=${storage}, path=${cachePath}, ${deps.recoveryMessage(error)}`,
      );
      if (storage === "fallback") {
        await deps
          .quarantineSqliteFiles(
            cachePath,
            `fallback-root-index-${deps.sha1(rootPath).slice(0, 10)}`,
            deps.recoveryMessage(error),
            deps.fallbackCacheRootDir(rootPath),
          )
          .catch((quarantineError) => {
            deps.appendStartupLog(
              `fallback root index quarantine skipped: ${deps.recoveryMessage(quarantineError)}`,
            );
          });
      }
      return null;
    }
  }

  async function tryReadLegacyFolderCache(
    rootPath: string,
    jsonPath: string,
    storage: "root" | "fallback",
  ): Promise<FolderCacheSource | null> {
    const cache = await readExistingScanCacheFile(jsonPath);
    if (!cache) return null;

    const sqlitePath = storage === "root" ? deps.rootIndexDbPath(rootPath) : deps.fallbackIndexDbPath(rootPath);
    await deps.saveRootIndexSqliteFile(sqlitePath, rootPath, storage, cache).catch((error) => {
      deps.appendStartupLog(
        `legacy ${storage} scan cache migration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    return { cache, cachePath: jsonPath, storage };
  }

  async function loadExistingFolderCache(
    rootPath: string,
    options: { applySharedMetadataOverlay?: boolean } = {},
  ): Promise<FolderCacheSource | null> {
    const resolvedRoot = resolve(rootPath);
    const rootDefaultDbPath = deps.rootIndexDbPath(resolvedRoot);
    const trust = await sharedIndexTrustRuntime.inspectSharedIndexTrust(resolvedRoot);
    if (!trust.trusted) {
      deps.appendStartupLog(
        `shared index trust load skipped: root=${resolvedRoot}, reason=${trust.reason}, db=${trust.activeDbPath}`,
      );
      return null;
    }

    for (const candidate of Array.from(new Set([trust.activeDbPath, rootDefaultDbPath]))) {
      const result = await tryReadRootIndexCache(resolvedRoot, candidate, "root", options);
      if (!result) continue;
      const usableFonts = Object.values(result.cache.entries || {}).filter((entry) => entry.status === "ok" && !!entry.font).length;
      if (usableFonts === 0 && (Boolean(trust.rootId) || (trust.expectedFileCount || 0) > 0)) {
        deps.appendStartupLog(
          `shared index trust load rejected empty usable index: root=${resolvedRoot}, rootId=${trust.rootId || ""}, expected=${trust.expectedFileCount || 0}, db=${candidate}`,
        );
        return null;
      }
      deps.appendStartupLog(
        `shared index trust load accepted: root=${resolvedRoot}, rootId=${trust.rootId || "legacy"}, fonts=${usableFonts}, reason=${trust.reason}, db=${candidate}`,
      );
      return result;
    }

    return null;
  }

  async function fileExistsForCachedFont(filePath: string): Promise<boolean> {
    try {
      const stat = await fsp.stat(filePath);
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async function persistRemovedCacheEntries(
    cacheSource: FolderCacheSource,
    rootPath: string,
    removedKeys: string[],
  ): Promise<void> {
    if (!removedKeys.length) return;

    if (isRootIndexDbPath(cacheSource.cachePath)) {
      await deps.saveRootIndexSqliteChanges(cacheSource.cachePath, rootPath, cacheSource.storage, [], removedKeys);
      return;
    }

    for (const key of removedKeys) delete cacheSource.cache.entries[key];
    await deps.saveScanCacheFile(cacheSource.cachePath, cacheSource.cache, rootPath, cacheSource.storage);
  }

  async function loadFolderCache(folders: string[]): Promise<ScanResult> {
    const startedAt = Date.now();
    const errors: ScanResult["errors"] = [];
    const fonts: FontItem[] = [];
    const cacheFolders: string[] = [];
    const missingCacheFolders: string[] = [];
    let totalFiles = 0;
    let fromCache = 0;
    let skippedBad = 0;

    const normalizedFolders = normalizeWatchedFontFolders(folders, deps.appendStartupLog);
    const availableFoldersResult = await filterFolderCacheAvailableRoots(
      normalizedFolders,
      deps.appendStartupLog,
      "folder-cache-load",
    );
    for (const skippedFolder of availableFoldersResult.skippedFolders) {
      missingCacheFolders.push(skippedFolder);
      errors.push({
        path: skippedFolder,
        message: "字体文件夹暂时不可访问，已跳过本轮缓存加载。",
      });
    }

    for (const folder of availableFoldersResult.folders) {
      try {
        const cacheSource = await loadExistingFolderCache(folder);
        if (!cacheSource) {
          missingCacheFolders.push(folder);
          continue;
        }

        const folderStat = await fsp.stat(folder).catch(() => null);
        if (!folderStat?.isDirectory()) {
          errors.push({
            path: folder,
            message: "字体文件夹不可访问，已跳过旧缓存加载。",
          });
          deps.appendStartupLog(`loadFolderCache skipped inaccessible folder: ${folder}`);
          continue;
        }

        cacheFolders.push(folder);
        const entries = Object.entries(cacheSource.cache.entries || {});
        totalFiles += entries.length;

        for (const [cacheKey, entry] of entries) {
          if (entry.status === "bad") {
            skippedBad += 1;
            continue;
          }
          if (!entry.font) continue;

          const entryPath = entry.path || cacheKey;
          const runtimePath = deps.cacheEntryRuntimePath(folder, entryPath);
          const runtimeFont = deps.cachedFontForRuntime(
            entry.font,
            runtimePath,
            {
              size: entry.fileSize,
              mtimeMs: entry.modifiedAt,
              birthtimeMs: entry.createdAt,
              ctimeMs: entry.createdAt,
            },
            cacheKey,
          );
          fonts.push(runtimeFont);
          fromCache += 1;
        }
      } catch (error) {
        errors.push({
          path: folder,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    deps.appendStartupLog(
      `loadFolderCache finished: folders=${normalizedFolders.length}, cacheFolders=${cacheFolders.length}, fonts=${fonts.length}, missing=${missingCacheFolders.length}, mode=fast-trusted-index, durationMs=${Date.now() - startedAt}`,
    );

    return {
      folders: normalizedFolders,
      fonts,
      errors,
      cacheOnly: true,
      cacheFolders,
      missingCacheFolders,
      stats: {
        totalFiles,
        parsed: 0,
        fromCache,
        skippedBad,
        errors: errors.length,
        durationMs: Date.now() - startedAt,
        workerCount: 0,
        queuedForWorkers: 0,
      },
    };
  }

  function invalidateSharedFontRuntimeCaches(): void {
    sharedFontsMemoryCache = null;
    deps.clearExternalFontQueryCaches();
  }

  async function loadSharedFontsForFoldersUncached(folders: string[]): Promise<FontItem[]> {
    const fonts: FontItem[] = [];
    const seen = new Set<string>();
    const availableFoldersResult = await filterFolderCacheAvailableRoots(
      folders,
      deps.appendStartupLog,
      "shared-font-cache-load",
    );
    for (const folder of availableFoldersResult.folders) {
      try {
        const cacheSource = await loadExistingFolderCache(folder);
        if (!cacheSource) continue;
        for (const [cacheKey, entry] of Object.entries(cacheSource.cache.entries || {})) {
          if (entry.status !== "ok" || !entry.font) continue;
          const runtimePath = deps.cacheEntryRuntimePath(folder, entry.path || cacheKey);
          const font = deps.cachedFontForRuntime(
            entry.font,
            runtimePath,
            {
              size: entry.fileSize,
              mtimeMs: entry.modifiedAt,
              birthtimeMs: entry.createdAt,
              ctimeMs: entry.createdAt,
            },
            cacheKey,
          );
          const key = font.id || normalizePathForCacheCompare(font.path);
          if (seen.has(key)) continue;
          seen.add(key);
          fonts.push(font);
        }
      } catch (error) {
        deps.appendStartupLog(
          `shared font load skipped: ${folder} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return fonts;
  }

  async function loadSharedFontsForFoldersFresh(folders: string[]): Promise<FontItem[]> {
    sharedFontsMemoryCache = null;
    return loadSharedFontsForFoldersUncached(folders);
  }

  async function loadSharedFontsForFoldersCached(folders: string[]): Promise<FontItem[]> {
    const foldersKey = sharedFontsFoldersKey(folders);
    const now = Date.now();
    if (
      sharedFontsMemoryCache &&
      sharedFontsMemoryCache.foldersKey === foldersKey &&
      now - sharedFontsMemoryCache.loadedAt < deps.sharedFontMemoryCacheTtlMs
    ) {
      return sharedFontsMemoryCache.fonts;
    }
    const fonts = await loadSharedFontsForFoldersUncached(folders);
    sharedFontsMemoryCache = { foldersKey, loadedAt: now, fonts };
    return fonts;
  }

  async function countSharedFontsForFolders(folders: string[]): Promise<number> {
    const foldersKey = sharedFontsFoldersKey(folders);
    const now = Date.now();
    if (
      sharedFontsMemoryCache &&
      sharedFontsMemoryCache.foldersKey === foldersKey &&
      now - sharedFontsMemoryCache.loadedAt < deps.sharedFontMemoryCacheTtlMs
    ) {
      return sharedFontsMemoryCache.fonts.length;
    }

    let total = 0;
    const availableFoldersResult = await filterFolderCacheAvailableRoots(
      folders,
      deps.appendStartupLog,
      "shared-font-cache-count",
    );
    for (const folder of availableFoldersResult.folders) {
      try {
        const cacheSource = await loadExistingFolderCache(folder, { applySharedMetadataOverlay: false });
        if (!cacheSource) continue;
        total += Object.values(cacheSource.cache.entries || {}).filter(
          (entry) => entry.status === "ok" && !!entry.font,
        ).length;
      } catch (error) {
        deps.appendStartupLog(
          `shared font count skipped: ${folder} ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return total;
  }

  return {
    readExistingScanCacheFile,
    tryReadRootIndexCache,
    tryReadLegacyFolderCache,
    loadExistingFolderCache,
    fileExistsForCachedFont,
    persistRemovedCacheEntries,
    loadFolderCache,
    invalidateSharedFontRuntimeCaches,
    loadSharedFontsForFolders: loadSharedFontsForFoldersCached,
    loadSharedFontsForFoldersFresh,
    countSharedFontsForFolders,
  };
}

export type FolderCacheRuntime = ReturnType<typeof createFolderCacheRuntime>;

export type { FolderCacheRuntimeDeps, FolderCacheSource } from "./folderCacheTypes";
