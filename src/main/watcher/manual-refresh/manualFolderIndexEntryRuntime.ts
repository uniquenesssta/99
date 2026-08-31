import { promises as fsp } from "node:fs";
import { extname } from "node:path";
import type { FontItem,ScanResult } from "../../../shared/types";
import type { FontScanCacheEntry,FontScanCacheFile } from "../../indexing/rootIndexRuntime";
import { relativePathForRoot } from "../../path/cachePath";
import type { RootScanCacheContext } from "../watchedFolderIndexRuntime";
import type { ManualFolderRefreshDeps } from "./manualFolderRefreshTypes";

export type ManualFolderIndexDeleteRecord = {
  path: string;
  relativePath: string;
  id?: string;
};

export function createManualFolderIndexEntryRuntime(deps: ManualFolderRefreshDeps) {
  const {
    fontExtensions: FONT_EXTENSIONS,
    scriptDetectionVersion: SCRIPT_DETECTION_VERSION,
    withGlobalIo,
    fileCacheSignature,
    cacheKeyForRootFile,
    cacheEntryRuntimePath,
    hasValidFontSignature,
    fontItemFromPath,
    sanitizeCachedFont,
    cachedFontForRuntime,
    scanFoldersRuntime,
  } = deps;

  function fontIndexDeleteRecord(
    rootPath: string,
    cacheKey: string,
    entry?: FontScanCacheEntry,
  ): ManualFolderIndexDeleteRecord {
    return {
      path: cacheEntryRuntimePath(rootPath, cacheKey),
      relativePath: cacheKey,
      id: entry?.font?.id,
    };
  }

  async function upsertFontIndexEntry(
    rootPath: string,
    filePath: string,
    cache: FontScanCacheFile,
  ): Promise<FontItem | null> {
    if (!FONT_EXTENSIONS.has(extname(filePath).toLowerCase())) return null;

    const stat = await withGlobalIo("index:stat-font", () => fsp.stat(filePath), {
      priority: "normal",
      storagePath: filePath,
    });
    if (!stat.isFile()) return null;

    const cacheKey = cacheKeyForRootFile(rootPath, filePath);
    const signature = fileCacheSignature(cacheKey, stat.size, stat.mtimeMs);
    const createdAt = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
    const existing = cache.entries[cacheKey];

    if (
      existing &&
      existing.cacheKey === signature &&
      existing.status === "ok" &&
      existing.font &&
      Array.isArray(existing.font.scripts) &&
      existing.font.scripts.length &&
      existing.font.scriptVersion === SCRIPT_DETECTION_VERSION
    ) {
      return cachedFontForRuntime(existing.font, filePath, stat, cacheKey);
    }
    if (
      existing &&
      existing.cacheKey === signature &&
      existing.status === "bad"
    ) {
      return null;
    }

    if (!(await hasValidFontSignature(filePath))) {
      cache.entries[cacheKey] = {
        path: cacheKey,
        cacheKey: signature,
        fileSize: stat.size,
        modifiedAt: stat.mtimeMs,
        createdAt,
        status: "bad",
        message: "不是有效字体签名，已跳过。",
        cachedAt: new Date().toISOString(),
      };
      return null;
    }

    const parsed = await fontItemFromPath(filePath);
    const cachedFont = sanitizeCachedFont(parsed, cacheKey, filePath, stat);
    cache.entries[cacheKey] = {
      path: cacheKey,
      cacheKey: signature,
      fileSize: stat.size,
      modifiedAt: stat.mtimeMs,
      createdAt,
      status: "ok",
      font: cachedFont,
      cachedAt: new Date().toISOString(),
    };

    return cachedFontForRuntime(cachedFont, filePath, stat, cacheKey);
  }

  function removeFontIndexEntriesForPath(
    rootPath: string,
    targetPath: string,
    cache: FontScanCacheFile,
  ): ManualFolderIndexDeleteRecord[] {
    const relativeKey = relativePathForRoot(rootPath, targetPath);
    const deletes: ManualFolderIndexDeleteRecord[] = [];
    if (!relativeKey) return deletes;

    const normalizedRelative = relativeKey
      .replaceAll("\\", "/")
      .toLowerCase()
      .replace(/\/+$/g, "");
    const isFont = FONT_EXTENSIONS.has(extname(normalizedRelative).toLowerCase());
    const prefix = `${normalizedRelative}/`;

    for (const [key, entry] of Object.entries(cache.entries || {})) {
      const normalizedKey = key.replaceAll("\\", "/").toLowerCase();
      const matched = isFont
        ? normalizedKey === normalizedRelative
        : normalizedKey === normalizedRelative ||
          normalizedKey.startsWith(prefix);
      if (!matched) continue;
      deletes.push(fontIndexDeleteRecord(rootPath, key, entry));
      delete cache.entries[key];
    }

    return deletes;
  }

  function makeRootScanCacheContext(
    rootPath: string,
    storage: {
      cachePath: string;
      cacheDir: string;
      storage: "root" | "fallback";
      cache: FontScanCacheFile;
    },
  ): RootScanCacheContext {
    return {
      rootPath,
      cachePath: storage.cachePath,
      cacheDir: storage.cacheDir,
      storage: storage.storage,
      cache: storage.cache,
      nextEntries: {},
      seenKeys: new Set<string>(),
      directoryUpdates: [],
      directorySkipped: 0,
    };
  }

  function fontIndexEntryChanged(
    oldEntry: FontScanCacheEntry | undefined,
    newEntry: FontScanCacheEntry | undefined,
  ): boolean {
    if (!newEntry) return false;
    if (!oldEntry) return true;
    return JSON.stringify(oldEntry) !== JSON.stringify(newEntry);
  }

  function relativeDirectoryPathForRoot(
    rootPath: string,
    dirPath: string,
  ): string {
    const rel = relativePathForRoot(rootPath, dirPath).replace(/\/+$/g, "");
    return rel === "." ? "" : rel;
  }

  function cacheKeyInsideDirectory(
    cacheKey: string,
    relativeDir: string,
  ): boolean {
    const key = cacheKey.replaceAll("\\", "/").toLowerCase();
    const dir = relativeDir
      .replaceAll("\\", "/")
      .toLowerCase()
      .replace(/\/+$/g, "");
    if (!dir) return true;
    return key.startsWith(`${dir}/`);
  }

  const readRootDirectorySignatures = (context: RootScanCacheContext) =>
    scanFoldersRuntime().readRootDirectorySignatures(context);
  const saveRootDirectorySignatures = (context: RootScanCacheContext) =>
    scanFoldersRuntime().saveRootDirectorySignatures(context);
  const listFontFilesWithDirectoryCache = (
    context: RootScanCacheContext,
    errors: ScanResult["errors"],
    progress?: (payload: {
      files: number;
      foldersScanned: number;
      skippedDirs: number;
    }) => void,
    signal?: AbortSignal,
    startDir?: string,
    listedBatch?: (items: Array<{ file: string; rootPath: string; stat: any | null; error: string }>) => void,
  ) =>
    scanFoldersRuntime().listFontFilesWithDirectoryCache(
      context,
      errors,
      progress,
      signal,
      startDir,
      listedBatch,
    );

  return {
    fontIndexDeleteRecord,
    upsertFontIndexEntry,
    removeFontIndexEntriesForPath,
    makeRootScanCacheContext,
    fontIndexEntryChanged,
    relativeDirectoryPathForRoot,
    cacheKeyInsideDirectory,
    readRootDirectorySignatures,
    saveRootDirectorySignatures,
    listFontFilesWithDirectoryCache,
  };
}

export type ManualFolderIndexEntryRuntime = ReturnType<typeof createManualFolderIndexEntryRuntime>;
