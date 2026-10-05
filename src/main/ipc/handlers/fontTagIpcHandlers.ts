import { BrowserWindow, dialog } from 'electron';
import type { createTagFontRecoveryRuntime } from '../../library/tagFontRecoveryRuntime';
import type { TagFontRecoveryRequest } from '../../../shared/tagFontRecovery';
import type { FontItem,FontTagBatchItem } from "../../../shared/types";
import type { IpcHandleRegistrar,IpcHandlerRuntime } from "../ipcHandlerTypes";

export function registerFontTagIpcHandlers(handle: IpcHandleRegistrar, runtime: IpcHandlerRuntime): void {
  let dialogWindow: BrowserWindow | null = null;
  let recovery: ReturnType<typeof createTagFontRecoveryRuntime> | undefined;
  const pickFile = async (font: FontItem): Promise<string | undefined> => {
    const options: Electron.OpenDialogOptions = {
      title: `重新链接：${font.fileName}（原路径：${font.path}）`, buttonLabel: '链接此文件',
      properties: ['openFile'], filters: [{ name: '字体文件', extensions: ['ttf', 'otf', 'ttc', 'otc'] }],
    };
    const result = await (dialogWindow && !dialogWindow.isDestroyed() ? dialog.showOpenDialog(dialogWindow, options) : dialog.showOpenDialog(options));
    return result.canceled ? undefined : result.filePaths[0];
  };
  handle('fonts:recoverTagFiles', async (event, request: TagFontRecoveryRequest) => {
    runtime.assertFeatureForChannel?.(request?.scope === 'shared' ? 'fonts:setSharedTagsBatch' : 'fonts:setLocalTagsBatch');
    const module = await import('../../library/tagFontRecoveryRuntime');
    recovery ||= module.createTagFontRecoveryRuntime(runtime, pickFile);
    dialogWindow = BrowserWindow.fromWebContents(event.sender);
    return recovery.recover(request);
  });
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
