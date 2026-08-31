import fs,{ promises as fsp } from "node:fs";
import { basename,extname,join,resolve } from "node:path";
import type { FontDeleteResult,FontItem,InstallResult,SystemInstalledFont } from "../../shared/types";
import { deleteFontFilesToTrashRuntime } from "./fontTrashDeleteRuntime";
import { installOverwriteTarget,removeSystemFontsWithCurrentPermission,systemUninstallCandidates } from "./systemFontInstallHelpersRuntime";

export interface SystemFontInstallRuntimeDeps {
  fontExtensions: Set<string>;
  ensureWindows: () => void;
  currentUserFontsDir: () => string;
  windowsFontsDir: () => string;
  registryNameFor: (item: FontItem) => string;
  normalizePathForCacheCompare: (path: string) => string;
  normalizeCompareText: (text: string) => string;
  isCleanWindowsDefaultFontName: (pathOrName: string) => boolean;
  isCleanWindowsDefaultCandidate: (candidate: SystemInstalledFont) => boolean;
  isCleanWindowsDefaultItem: (item: FontItem) => boolean;
  isTemporaryActiveInstalledRecord: (record: SystemInstalledFont) => boolean;
  isPathInsideAnyRoot: (filePath: string, roots: string[]) => boolean;
  getSystemInstalledFonts: () => Promise<SystemInstalledFont[]>;
  getSystemInstalledFontsCached: (forceRefresh?: boolean) => Promise<SystemInstalledFont[]>;
  clearInstalledFontsMemoryCache: () => void;
  writeFontRegistryValuesHKCUBatch: (items: Array<{ name: string; path: string }>) => Promise<void>;
  deleteFontRegistryValuesHKCUBatch: (names: string[]) => Promise<void>;
  advancedFontRefresh: (reason: string) => Promise<void>;
  activationTraceStep: <T>(label: string, fontId: string, fn: () => Promise<T>) => Promise<T>;
  appendStartupLog: (message: string) => void;
}

export function createSystemFontInstallRuntime(deps: SystemFontInstallRuntimeDeps): {
  installFontSystemWide: (item: FontItem) => Promise<InstallResult>;
  uninstallFontSystemWide: (item: FontItem) => Promise<InstallResult>;
  deleteFontFilesToTrash: (items: FontItem[], watchedFolders: string[]) => Promise<FontDeleteResult>;
} {
  async function installFontSystemWide(item: FontItem): Promise<InstallResult> {
    deps.ensureWindows();
    await fsp.access(item.path);

    const fontsDir = deps.currentUserFontsDir();
    await deps.activationTraceStep("ensure-user-fonts-dir", item.id, () =>
      fsp.mkdir(fontsDir, { recursive: true }),
    );

    const original = basename(item.path).replace(/[<>:"/\\|?*]/g, "_");
    const ext = extname(original) || extname(item.fileName) || ".ttf";
    const copyName = original || `${item.id.slice(0, 12)}${ext}`;
    const fallbackDest = join(fontsDir, copyName);
    const installed = await deps.getSystemInstalledFontsCached(true);
    const dest = installOverwriteTarget(item, installed, fontsDir, fallbackDest, deps);

    const source = deps.normalizePathForCacheCompare(resolve(item.path));
    const target = deps.normalizePathForCacheCompare(resolve(dest));
    const replacing = fs.existsSync(dest) && source !== target;
    if (source !== target) {
      await fsp.copyFile(item.path, dest);
    }

    const regName = deps.registryNameFor(item);
    await deps.writeFontRegistryValuesHKCUBatch([{ name: regName, path: dest }]);

    deps.clearInstalledFontsMemoryCache();

    return {
      ok: true,
      message: replacing
        ? "已覆盖安装到 Windows 当前用户字体目录。为避免资源管理器卡死，本版不会强制刷新 Explorer。"
        : "已安装到 Windows 当前用户字体目录。为避免资源管理器卡死，本版不会强制刷新 Explorer。",
    };
  }

  async function deleteFontFilesToTrash(
    items: FontItem[],
    watchedFolders: string[],
  ): Promise<FontDeleteResult> {
    return deleteFontFilesToTrashRuntime(items, watchedFolders, deps);
  }

  async function uninstallFontSystemWide(item: FontItem): Promise<InstallResult> {
    deps.ensureWindows();

    if (item.deleteProtected || deps.isCleanWindowsDefaultItem(item)) {
      return {
        ok: false,
        message:
          "已跳过：这是受保护字体，为避免误删或破坏 Windows 字体环境，不允许移除。",
      };
    }

    const installed = await deps.getSystemInstalledFonts();
    const candidates = systemUninstallCandidates(item, installed, deps).filter(
      (candidate) =>
        !deps.isCleanWindowsDefaultCandidate(candidate) &&
        !deps.isTemporaryActiveInstalledRecord(candidate),
    );

    if (!candidates.length) {
      return {
        ok: false,
        message: "没有找到可移除的已安装记录；受保护字体会被自动跳过。",
      };
    }

    const userFontsRoot = deps.currentUserFontsDir().toLowerCase();
    const windowsFontsRoot = deps.windowsFontsDir().toLowerCase();

    const hkcuNames = candidates
      .filter((candidate) => candidate.source === "HKCU")
      .map((candidate) => candidate.registryName)
      .filter(Boolean);

    const hklmNames = Array.from(
      new Set(
        candidates
          .filter((candidate) => candidate.source === "HKLM")
          .map((candidate) => candidate.registryName)
          .filter(Boolean),
      ),
    );

    const hkcuFilePaths = Array.from(
      new Set(
        candidates
          .map((candidate) => candidate.path)
          .filter((path): path is string => !!path)
          .filter((path) => {
            const lower = path.toLowerCase();
            return lower.startsWith(userFontsRoot) && deps.fontExtensions.has(extname(path).toLowerCase());
          }),
      ),
    );

    const windowsFontPaths = Array.from(
      new Set(
        candidates
          .map((candidate) => candidate.path)
          .filter((path): path is string => !!path)
          .filter((path) => {
            const lower = path.toLowerCase();
            return (
              lower.startsWith(windowsFontsRoot) &&
              deps.fontExtensions.has(extname(path).toLowerCase()) &&
              !deps.isCleanWindowsDefaultFontName(path)
            );
          }),
      ),
    );

    if (hkcuNames.length) {
      try {
        await deps.deleteFontRegistryValuesHKCUBatch(hkcuNames);
      } catch {
        // Continue with files / other scopes.
      }
    }

    for (const filePath of hkcuFilePaths) {
      try {
        await fsp.unlink(filePath);
      } catch {
        // The file may be in use or already gone.
      }
    }

    if (hklmNames.length || windowsFontPaths.length) {
      try {
        await removeSystemFontsWithCurrentPermission(hklmNames, windowsFontPaths, deps);
      } catch (error) {
        if (error instanceof Error && error.message === "NEED_ADMIN_PERMISSION") {
          return {
            ok: false,
            message:
              "当前权限不足：Windows 不允许普通权限进程移除 HKLM / C:\\Windows\\Fonts 中的字体。已取消系统级移除；请以管理员身份启动本软件后重试。本软件不会弹出 PowerShell。",
          };
        }

        throw error;
      }
    }

    deps.clearInstalledFontsMemoryCache();
    await deps.advancedFontRefresh("uninstall-font");

    const parts = [
      hkcuNames.length ? `HKCU 记录 ${hkcuNames.length} 条` : "",
      hkcuFilePaths.length ? `当前用户字体文件 ${hkcuFilePaths.length} 个` : "",
      hklmNames.length ? `HKLM 记录 ${hklmNames.length} 条` : "",
      windowsFontPaths.length ? `Windows 字体文件 ${windowsFontPaths.length} 个` : "",
    ].filter(Boolean);

    return {
      ok: true,
      message: `已移除可移除字体：${parts.join("，") || `${candidates.length} 项`}。`,
    };
  }

  return {
    installFontSystemWide,
    uninstallFontSystemWide,
    deleteFontFilesToTrash,
  };
}
