import { basename, join } from "node:path";
import type { FontItem } from "../../shared/types";
import type { AuthorizeManagedFontDelete } from "../path/fontPathAuthorizationRuntime";

export type AuthorizedManagedFontRemoval = {
  installPath: string;
  registryName: string;
};

export type ManagedFontOwnershipRuntimeOptions = {
  currentUserFontsDir: () => string;
  safeManagedFontName: (item: FontItem) => string;
  registryNameFor: (item: FontItem) => string;
  normalizePathForCompare: (filePath: string) => string;
  findFontItemInRootIndexes: (
    fontId: string,
    normalizedPath: string,
  ) => Promise<FontItem | null>;
  authorizeManagedFontDelete: AuthorizeManagedFontDelete;
};

export type ManagedFontOwnershipRuntime = {
  authorizeManagedFontRemoval: (
    item: FontItem,
  ) => Promise<AuthorizedManagedFontRemoval>;
};

export function createManagedFontOwnershipRuntime(
  options: ManagedFontOwnershipRuntimeOptions,
): ManagedFontOwnershipRuntime {
  async function authoritativeSourceFor(item: FontItem): Promise<FontItem | null> {
    if (
      typeof item?.id !== "string" ||
      !item.id ||
      typeof item.path !== "string" ||
      !item.path
    ) {
      return null;
    }

    let normalizedPath = "";
    try {
      normalizedPath = options.normalizePathForCompare(item.path);
    } catch {
      return null;
    }
    if (!normalizedPath) return null;

    const indexed = await options.findFontItemInRootIndexes("", normalizedPath);
    if (
      !indexed ||
      indexed.id !== item.id ||
      options.normalizePathForCompare(indexed.path) !== normalizedPath
    ) {
      return null;
    }
    return indexed;
  }

  async function authorizeManagedFontRemoval(
    item: FontItem,
  ): Promise<AuthorizedManagedFontRemoval> {
    if (!item.managedInstallPath || !item.managedRegistryName) {
      throw new Error("这个字体不是由本工具安装的，已跳过。");
    }

    const source = await authoritativeSourceFor(item);
    if (!source) {
      throw new Error("安全保护：主进程字体索引无法确认受管字体身份。");
    }

    const authorized = await options.authorizeManagedFontDelete(
      item.managedInstallPath,
    );
    if (!authorized.ok) {
      throw new Error(`安全保护：${authorized.message}`);
    }

    const expectedName = options.safeManagedFontName(source);
    if (basename(authorized.value.ioPath) !== expectedName) {
      throw new Error("安全保护：托管字体文件名不一致。");
    }

    const expectedPath = join(options.currentUserFontsDir(), expectedName);
    const expected = await options.authorizeManagedFontDelete(expectedPath);
    if (
      !expected.ok ||
      expected.value.realComparePath !== authorized.value.realComparePath
    ) {
      throw new Error("安全保护：托管字体安装路径不一致。");
    }

    const expectedRegistryName = options.registryNameFor(source);
    if (item.managedRegistryName !== expectedRegistryName) {
      throw new Error("安全保护：托管字体注册表身份不一致。");
    }

    return {
      installPath: authorized.value.ioPath,
      registryName: expectedRegistryName,
    };
  }

  return { authorizeManagedFontRemoval };
}
