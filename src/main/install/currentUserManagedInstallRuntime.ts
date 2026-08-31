import { promises as fsp } from "node:fs";
import { basename,join } from "node:path";
import type { FontItem,InstallResult } from "../../shared/types";

type RegistryValue = { name: string; path: string };

export type CurrentUserManagedInstallRuntimeOptions = {
  appName: string;
  ensureWindows: () => void;
  currentUserFontsDir: () => string;
  safeManagedFontName: (item: FontItem) => string;
  registryNameFor: (item: FontItem) => string;
  writeFontRegistryValuesHKCUBatch: (
    values: RegistryValue[],
  ) => Promise<void>;
  deleteFontRegistryValuesHKCUBatch: (names: string[]) => Promise<void>;
  broadcastFontChange: () => Promise<void>;
};

export type CurrentUserManagedInstallRuntime = {
  installFontForCurrentUser: (item: FontItem) => Promise<InstallResult>;
  uninstallManagedFont: (item: FontItem) => Promise<InstallResult>;
};

export function createCurrentUserManagedInstallRuntime(
  options: CurrentUserManagedInstallRuntimeOptions,
): CurrentUserManagedInstallRuntime {
  async function installFontForCurrentUser(
    item: FontItem,
  ): Promise<InstallResult> {
    options.ensureWindows();

    const src = item.path;
    await fsp.access(src);

    const fontsDir = options.currentUserFontsDir();
    await fsp.mkdir(fontsDir, { recursive: true });

    const managedName = options.safeManagedFontName(item);
    const dest = join(fontsDir, managedName);
    await fsp.copyFile(src, dest);

    const regName = options.registryNameFor(item);
    await options.writeFontRegistryValuesHKCUBatch([
      { name: regName, path: dest },
    ]);

    await options.broadcastFontChange();

    return {
      ok: true,
      managedInstallPath: dest,
      managedRegistryName: regName,
      message: "已安装到当前用户字体目录。",
    };
  }

  async function uninstallManagedFont(item: FontItem): Promise<InstallResult> {
    options.ensureWindows();

    if (!item.managedInstallPath || !item.managedRegistryName) {
      throw new Error("这个字体不是由本工具安装的，已跳过。");
    }

    if (!basename(item.managedInstallPath).startsWith(options.appName + "_")) {
      throw new Error("安全保护：不会移除非本工具安装的字体文件。");
    }

    try {
      await options.deleteFontRegistryValuesHKCUBatch([
        item.managedRegistryName,
      ]);
    } catch {
      // 注册表项可能已不存在，继续清理文件。
    }

    try {
      await fsp.unlink(item.managedInstallPath);
    } catch {
      // 文件可能已不存在。
    }

    await options.broadcastFontChange();

    return {
      ok: true,
      message: "已移除本工具安装的字体副本。",
    };
  }

  return {
    installFontForCurrentUser,
    uninstallManagedFont,
  };
}
