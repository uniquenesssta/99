import type { FontItem,InstallCompareOptions } from "../../../shared/types";
import type { IpcHandleRegistrar,IpcHandlerRuntime } from "../ipcHandlerTypes";

export function registerFontSystemIpcHandlers(handle: IpcHandleRegistrar, runtime: IpcHandlerRuntime): void {
  handle("fonts:getSystemInstalledFonts", () => runtime.getSystemInstalledFonts());
  handle("fonts:scanSystemInstalledFonts", () => runtime.scanSystemInstalledFonts());
  handle("fonts:compareInstalled", (_event, item: FontItem) => runtime.compareFontInstalled(item));
  handle("fonts:compareManyInstalled", (_event, items: FontItem[], options?: InstallCompareOptions) =>
    runtime.compareFontsInstalled(items, options || {}),
  );
  handle("fonts:refreshInstallStatusIndex", (_event, options?: InstallCompareOptions) =>
    runtime.refreshInstallStatusIndex(options || { force: true }, { emitProgress: true }),
  );
  handle("fonts:startInstallStatusRefreshIndex", (_event, options?: InstallCompareOptions) =>
    runtime.startInstallStatusRefreshIndex(options || { force: true }),
  );
  handle("fonts:getInstallStatusIndex", (_event, items: FontItem[]) => runtime.getInstallStatusIndexSnapshot(items));
  handle("fonts:installSystem", (_event, item: FontItem) => runtime.installFontSystemWide(item));
  handle("fonts:uninstallSystem", (_event, item: FontItem) => runtime.uninstallFontSystemWide(item));
  handle("fonts:deleteFiles", (_event, items: FontItem[], watchedFolders: string[]) =>
    runtime.deleteFontFilesToTrash(items, watchedFolders),
  );
  handle("fonts:setDeleteProtection", (_event, items: FontItem[], watchedFolders: string[], protect: boolean) =>
    runtime.setFontDeleteProtectionInIndex(items, watchedFolders, !!protect),
  );
  handle("fonts:setFavorite", (_event, items: FontItem[], watchedFolders: string[], favorite: boolean) =>
    runtime.setSharedFontFavoriteInIndex(items, watchedFolders, !!favorite),
  );
  handle("fonts:activateFont", (_event, item: FontItem) => runtime.activateFontSession(item));
  handle("fonts:activateFonts", (_event, items: FontItem[]) => runtime.activateFontSessionsBatch(items || []));
  handle("fonts:deactivateFont", (_event, item: FontItem) => runtime.deactivateFontSession(item));
  handle("fonts:deactivateFonts", (_event, items: FontItem[]) => runtime.deactivateFontSessionsBatch(items || []));
  handle("fonts:installCurrentUser", (_event, item: FontItem) => runtime.installFontForCurrentUser(item));
  handle("fonts:uninstallManaged", (_event, item: FontItem) => runtime.uninstallManagedFont(item));
}
