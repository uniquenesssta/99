import { shell } from "electron";
import { createPreviewRequestSchedulerRuntime } from "../../preview/runtime/previewRequestSchedulerRuntime";
import type { FontItem } from "../../../shared/types";
import type { IpcHandleRegistrar,IpcHandlerRuntime } from "../ipcHandlerTypes";

export function registerPreviewAndFolderIpcHandlers(handle: IpcHandleRegistrar, runtime: IpcHandlerRuntime): void {
  const previewRequestScheduler = createPreviewRequestSchedulerRuntime({
    readCachedPreviewImages: (items, text, fontSize, width, height) => runtime.readCachedFontPreviewImages(items, text, fontSize, width, height) as Promise<Record<string, string>>,
    appendStartupLog: runtime.appendLog
  });
  handle("path:toFontUrl", (_event, filePath: string) => `hfm-font://local/${encodeURIComponent(filePath)}`);
  handle("fonts:readPreviewFontData", (_event, item: FontItem) => runtime.readPreviewFontData(item));
  handle("fonts:renderPreviewImage", (_event, item: FontItem, text: string, fontSize: number, width: number, height: number) =>
    runtime.renderFontPreviewImage(item, text, fontSize, width, height),
  );
  handle("fonts:getCachedPreviewImage", (_event, item: FontItem, text: string, fontSize: number, width: number, height: number) =>
    runtime.readCachedFontPreviewImage(item, text, fontSize, width, height),
  );
  handle("fonts:getCachedPreviewImages", (_event, items: FontItem[], text: string, fontSize: number, width: number, height: number) =>
    previewRequestScheduler.readCachedPreviewImages(items, text, fontSize, width, height),
  );
  handle("fonts:ensurePreviewCache", (_event, item: FontItem, text: string, fontSize: number, width: number, height: number) =>
    runtime.ensureFontPreviewCache(item, text, fontSize, width, height),
  );
  handle("fonts:getPreviewCacheStatus", (_event, items: FontItem[], text: string, fontSize: number, width: number, height: number) =>
    runtime.getPreviewCacheStatus(items, text, fontSize, width, height),
  );
  handle("folders:createPhysical", (_event, parentPath: string, name: string) =>
    runtime.createPhysicalFolder(parentPath, name),
  );
  handle("folders:renamePhysical", (_event, folderPath: string, name: string) =>
    runtime.renamePhysicalFolder(folderPath, name),
  );
  handle("folders:listPhysicalTree", (_event, folders: string[]) => runtime.listPhysicalFolderTree(folders));
  handle("fonts:moveFileToFolder", (_event, item: FontItem, targetFolder: string) =>
    runtime.moveFontFileToFolder(item, targetFolder),
  );
  handle("fonts:moveFilesToFolder", (_event, items: FontItem[], targetFolder: string) =>
    runtime.moveFontFilesToFolder ? runtime.moveFontFilesToFolder(items, targetFolder) : Promise.all((items || []).map((item) => runtime.moveFontFileToFolder(item, targetFolder))),
  );
  handle("shell:showItemInFolder", (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
    return true;
  });
}
