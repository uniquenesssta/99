import { basename } from "node:path";
import type { FontItem } from "../../shared/types";
import type {
FontScanCacheEntry,
FontScanCacheFile,
RootIndexStorage,
} from "./rootIndexRuntime";

export type SharedIndexCacheSource = {
  cache: FontScanCacheFile;
  cachePath: string;
  storage: RootIndexStorage;
};

export type SharedIndexMutationFailure = {
  id: string;
  fileName: string;
  message: string;
};

export interface SharedIndexMutationDeps {
  findBestWatchedRootForFile: (
    filePath: string,
    folders: string[],
  ) => string | null;
  cacheKeyForRootFile: (rootPath: string, filePath: string) => string;
  cacheEntryRuntimePath: (rootPath: string, entryPath: string) => string;
  normalizePathForCacheCompare: (path: string) => string;
  loadExistingFolderCache: (
    rootPath: string,
  ) => Promise<SharedIndexCacheSource | null>;
  isRootIndexDbPath: (filePath: string) => boolean;
  saveRootIndexSqliteChanges: (
    filePath: string,
    rootPath: string,
    storage: RootIndexStorage,
    upserts: Array<[string, FontScanCacheEntry]>,
    deletes: string[],
  ) => Promise<void>;
  saveScanCacheFile: (
    filePath: string,
    cache: FontScanCacheFile,
    rootPath?: string,
    storage?: RootIndexStorage,
  ) => Promise<void>;
}

export interface SharedIndexMutationOptions {
  watchedFolders: string[];
  items: FontItem[];
  emptyPathMessage: string;
  outsideRootMessage: string;
  missingIndexMessage: string;
  missingEntryMessage: string;
  mutateFont: (font: FontItem, item: FontItem) => FontItem;
}

function uniqueFontItems(items: FontItem[]): FontItem[] {
  return Array.from(
    new Map(
      (items || []).filter((item) => !!item?.id).map((item) => [item.id, item]),
    ).values(),
  );
}

export function createSharedIndexMutationRuntime(
  deps: SharedIndexMutationDeps,
) {
  async function updateSharedFontEntries(
    options: SharedIndexMutationOptions,
  ): Promise<{ updatedIds: string[]; failed: SharedIndexMutationFailure[] }> {
    const updatedIds: string[] = [];
    const failed: SharedIndexMutationFailure[] = [];
    const watchedFolders = options.watchedFolders || [];
    const groups = new Map<string, FontItem[]>();

    for (const item of uniqueFontItems(options.items)) {
      const fileName =
        item.fileName || (item.path ? basename(item.path) : item.id);

      try {
        if (!item.path) throw new Error(options.emptyPathMessage);
        const root = deps.findBestWatchedRootForFile(item.path, watchedFolders);
        if (!root) throw new Error(options.outsideRootMessage);

        const list = groups.get(root) || [];
        list.push(item);
        groups.set(root, list);
      } catch (error) {
        failed.push({
          id: item.id,
          fileName,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const [root, items] of groups) {
      let cacheSource: SharedIndexCacheSource | null = null;

      try {
        cacheSource = await deps.loadExistingFolderCache(root);
        if (!cacheSource) throw new Error(options.missingIndexMessage);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const item of items) {
          failed.push({
            id: item.id,
            fileName: item.fileName || (item.path ? basename(item.path) : item.id),
            message,
          });
        }
        continue;
      }

      const upserts: Array<[string, FontScanCacheEntry]> = [];
      const groupUpdatedIds: string[] = [];
      const groupUpdatedItems = new Map<string, FontItem>();

      for (const item of items) {
        const fileName = item.fileName || (item.path ? basename(item.path) : item.id);

        try {
          let cacheKey = deps.cacheKeyForRootFile(root, item.path);
          let entry = cacheSource.cache.entries[cacheKey];

          if (!entry?.font) {
            const matched = Object.entries(cacheSource.cache.entries || {}).find(
              ([, candidate]) => {
                if (candidate.status !== "ok" || !candidate.font) return false;
                if (candidate.font.id === item.id) return true;
                const runtimePath = deps.cacheEntryRuntimePath(
                  root,
                  candidate.path || "",
                );
                return (
                  deps.normalizePathForCacheCompare(runtimePath) ===
                  deps.normalizePathForCacheCompare(item.path || "")
                );
              },
            );
            if (matched) {
              cacheKey = matched[0];
              entry = matched[1];
            }
          }

          if (!entry?.font) throw new Error(options.missingEntryMessage);

          const nextEntry: FontScanCacheEntry = {
            ...entry,
            font: options.mutateFont(entry.font, item),
            cachedAt: new Date().toISOString(),
          };

          cacheSource.cache.entries[cacheKey] = nextEntry;
          upserts.push([cacheKey, nextEntry]);
          groupUpdatedIds.push(item.id);
          groupUpdatedItems.set(item.id, item);
        } catch (error) {
          failed.push({
            id: item.id,
            fileName,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!upserts.length) continue;

      try {
        if (deps.isRootIndexDbPath(cacheSource.cachePath)) {
          await deps.saveRootIndexSqliteChanges(
            cacheSource.cachePath,
            root,
            cacheSource.storage,
            upserts,
            [],
          );
        } else {
          await deps.saveScanCacheFile(
            cacheSource.cachePath,
            cacheSource.cache,
            root,
            cacheSource.storage,
          );
        }

        updatedIds.push(...groupUpdatedIds);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const id of groupUpdatedIds) {
          const item = groupUpdatedItems.get(id);
          failed.push({
            id,
            fileName: item?.fileName || (item?.path ? basename(item.path) : id),
            message,
          });
        }
      }
    }

    return { updatedIds, failed };
  }



  async function removeSharedTagFromIndexes(
    tagNameInput: string,
    watchedFoldersInput: string[],
  ): Promise<{ updatedIds: string[]; failed: SharedIndexMutationFailure[] }> {
    const tagName = String(tagNameInput || "").trim();
    const watchedFolders = Array.from(new Set(watchedFoldersInput || [])).filter(Boolean);
    const updatedIds: string[] = [];
    const failed: SharedIndexMutationFailure[] = [];
    if (!tagName) return { updatedIds, failed };

    for (const root of watchedFolders) {
      let cacheSource: SharedIndexCacheSource | null = null;
      try {
        cacheSource = await deps.loadExistingFolderCache(root);
        if (!cacheSource) throw new Error("没有找到共享索引库，请先更新索引。");
      } catch (error) {
        failed.push({
          id: root,
          fileName: basename(root),
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const upserts: Array<[string, FontScanCacheEntry]> = [];
      for (const [cacheKey, entry] of Object.entries(cacheSource.cache.entries || {})) {
        const font = entry.font;
        if (!font?.id || !Array.isArray(font.tagNames) || !font.tagNames.includes(tagName)) continue;
        const nextTags = font.tagNames.filter((tag) => tag !== tagName);
        const nextEntry: FontScanCacheEntry = {
          ...entry,
          font: { ...font, tagNames: nextTags },
          cachedAt: new Date().toISOString(),
        };
        cacheSource.cache.entries[cacheKey] = nextEntry;
        upserts.push([cacheKey, nextEntry]);
      }

      if (!upserts.length) continue;

      try {
        if (deps.isRootIndexDbPath(cacheSource.cachePath)) {
          await deps.saveRootIndexSqliteChanges(cacheSource.cachePath, root, cacheSource.storage, upserts, []);
        } else {
          await deps.saveScanCacheFile(cacheSource.cachePath, cacheSource.cache, root, cacheSource.storage);
        }
        updatedIds.push(...upserts.map(([, entry]) => entry.font?.id || "").filter(Boolean));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const [, entry] of upserts) {
          const font = entry.font;
          failed.push({
            id: font?.id || entry.path || root,
            fileName: font?.fileName || (font?.path ? basename(font.path) : entry.path || basename(root)),
            message,
          });
        }
      }
    }

    return { updatedIds, failed };
  }

  return { updateSharedFontEntries, removeSharedTagFromIndexes };
}
