import { promises as fsp } from "node:fs";
import { join } from "node:path";
import type { FontItem,InstallResult } from "../../shared/types";
import type {
  AuthorizedManagedFontRemoval,
  ManagedFontOwnershipRuntime,
} from "./managedFontOwnershipRuntime";

type RegistryValue = { name: string; path: string };

export type CurrentUserManagedInstallRuntimeOptions = {
  ensureWindows: () => void;
  currentUserFontsDir: () => string;
  safeManagedFontName: (item: FontItem) => string;
  registryNameFor: (item: FontItem) => string;
  authorizeManagedFontRemoval: ManagedFontOwnershipRuntime["authorizeManagedFontRemoval"];
  writeFontRegistryValuesHKCUBatch: (
    values: RegistryValue[],
  ) => Promise<void>;
  deleteFontRegistryValuesHKCUBatch: (names: string[]) => Promise<void>;
  broadcastFontChange: () => Promise<void>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

    const removal: AuthorizedManagedFontRemoval =
      await options.authorizeManagedFontRemoval(item);

    try {
      await options.deleteFontRegistryValuesHKCUBatch([
        removal.registryName,
      ]);
    } catch (error) {
      return {
        ok: false,
        message: `未移除字体：注册表记录清理失败，字体文件已保留。${errorMessage(error)}`,
      };
    }

    try {
      await fsp.unlink(removal.installPath);
    } catch (fileError) {
      let registryRestored = false;
      let registryRestoreError: unknown = null;
      try {
        await options.writeFontRegistryValuesHKCUBatch([
          { name: removal.registryName, path: removal.installPath },
        ]);
        registryRestored = true;
      } catch (error) {
        registryRestoreError = error;
      }

      let broadcastError: unknown = null;
      try {
        await options.broadcastFontChange();
      } catch (error) {
        broadcastError = error;
      }

      const details = [
        `字体文件删除失败：${errorMessage(fileError)}`,
        registryRestored
          ? "注册表记录已恢复。"
          : `注册表记录恢复失败：${errorMessage(registryRestoreError)}`,
        broadcastError
          ? `字体刷新失败：${errorMessage(broadcastError)}`
          : "",
      ].filter(Boolean);
      return {
        ok: false,
        message: `未能完整移除本工具安装的字体副本。${details.join(" ")}`,
      };
    }

    try {
      await options.broadcastFontChange();
    } catch (error) {
      return {
        ok: false,
        message: `字体副本和注册表记录已移除，但字体刷新失败：${errorMessage(error)}`,
      };
    }

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
