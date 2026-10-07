import type { FontItem,FontTagBatchItem } from "../../../shared/types";
import type { IpcHandleRegistrar,IpcHandlerRuntime } from "../ipcHandlerTypes";

export function registerFontTagIpcHandlers(handle: IpcHandleRegistrar, runtime: IpcHandlerRuntime): void {
  handle("fonts:setLocalTags", (_event, item: FontItem, tagNames: string[]) =>
    runtime.setLocalFontTags(item, tagNames),
  );
  handle("fonts:setLocalTagsBatch", (_event, items: FontTagBatchItem[]) =>
    runtime.setLocalFontTagsBatch(items || []),
  );
  handle("fonts:deleteLocalTag", (_event, tagName: string) =>
    runtime.deleteLocalFontTag(tagName),
  );
  handle("fonts:setSharedTags", (_event, items: FontItem[], watchedFolders: string[], tagNames: string[]) =>
    runtime.setSharedFontTagsInIndex(items, watchedFolders, tagNames),
  );
  handle("fonts:setSharedTagsBatch", (_event, items: FontTagBatchItem[], watchedFolders: string[]) =>
    runtime.setSharedFontTagsBatchInIndex(items || [], watchedFolders || []),
  );
  handle("fonts:renameSharedTag", (_event, oldTagName: string, newTagName: string, watchedFolders: string[]) =>
    runtime.renameSharedFontTagInIndex(oldTagName, newTagName, watchedFolders || []),
  );
  handle("fonts:deleteSharedTag", (_event, tagName: string, watchedFolders: string[]) =>
    runtime.deleteSharedFontTagInIndex(tagName, watchedFolders || []),
  );
}
