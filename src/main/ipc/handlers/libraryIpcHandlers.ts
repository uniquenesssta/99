import { dialog } from "electron";
import type { FontItem,FontQueryRequest,LibraryState } from "../../../shared/types";
import type { IpcHandleRegistrar,IpcHandlerRuntime } from "../ipcHandlerTypes";


let selectFontFoldersDialogTask: Promise<string[]> | null = null

function selectFontFoldersOnce(): Promise<string[]> {
  if (selectFontFoldersDialogTask) return selectFontFoldersDialogTask
  let task: Promise<string[]>
  task = dialog.showOpenDialog({
    title: "选择字体文件夹",
    properties: ["openDirectory", "multiSelections"],
  }).then((result) => result.canceled ? [] : result.filePaths)
    .finally(() => {
      if (selectFontFoldersDialogTask === task) selectFontFoldersDialogTask = null
    })
  selectFontFoldersDialogTask = task
  return task
}

export function registerLibraryIpcHandlers(handle: IpcHandleRegistrar, runtime: IpcHandlerRuntime): void {
  handle("library:load", () => runtime.loadLibrary());
  handle("library:loadShell", () => runtime.loadLibraryShell());
  handle("library:save", (_event, state: LibraryState) => runtime.saveLibrary(state));

  handle("dialog:selectFontFolders", () => selectFontFoldersOnce());

  handle("fonts:scanFolders", (_event, folders: string[], knownFonts?: FontItem[]) =>
    runtime.scanFoldersManaged(folders, knownFonts),
  );
  handle("fonts:cancelScan", (_event, reason?: string) =>
    runtime.cancelActiveFontScan(reason || "用户取消了索引扫描。"),
  );
  handle("fonts:getScanStatus", () => runtime.activeFontScanStatus());
  handle("fonts:loadFolderCache", (_event, folders: string[]) => runtime.loadFolderCache(folders));
  handle("fonts:search", (_event, keyword: string, limit?: number) =>
    runtime.searchFontsInLibrary(keyword, limit),
  );
  handle("fonts:query", (_event, request: FontQueryRequest) => runtime.queryFontsInLibrary(request));
  handle("fonts:queryPage", (_event, request: FontQueryRequest) => runtime.queryFontPageInLibrary(request));
  handle("fonts:checkSharedMetadataUpdates", (_event, reason?: string) => runtime.checkSharedMetadataUpdates(reason));
  handle("fonts:getMetrics", () => runtime.getFontMetricsFromLibrary());
  handle("folders:watch", (_event, folders: string[]) => runtime.startWatchingFolders(folders));
  handle("folders:refreshWatched", (_event, folderPath: string, rootPath?: string) =>
    runtime.refreshWatchedFolder(folderPath, rootPath),
  );
}
