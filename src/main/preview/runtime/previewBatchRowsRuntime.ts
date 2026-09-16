import { join } from "node:path";
import type { FontItem, LibraryState } from "../../../shared/types";
import type { PreviewCacheStorage, PreviewRuntimeOptions } from "./previewRuntimeTypes";
import type { PreviewCacheHydrationRow } from "./previewCacheHydrationRuntime";
import { previewCacheKey, previewCacheTextHash, previewFontSignature } from "./previewCacheKeyRuntime";
import { previewCacheIdentityForInstalledRoute, previewCacheStatForInstalledRoute, resolveInstalledFontPreviewRoute } from "./previewInstalledFontRouteRuntime";

export function createPreviewBatchRowsRuntime(
  options: Pick<PreviewRuntimeOptions, "sha1" | "normalizePathForCacheCompare">,
  previewCacheStorageForFontFromIndex: (fontPath: string, library: LibraryState) => PreviewCacheStorage,
) {
  function buildPreviewCacheGroups(
    items: FontItem[], libraryShell: LibraryState, normalizedText: string,
    fontSize: number, width: number, height: number, onInvalidId?: (id: string) => void,
  ) {
    const groups = new Map<
      string,
      { storage: PreviewCacheStorage; rows: PreviewCacheHydrationRow[] }
    >();
    for (const item of items || []) {
      if (!item || !item.id || !item.path) {
        if (item?.id) onInvalidId?.(item.id);
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

    return groups;
  }
  return { buildPreviewCacheGroups };
}
