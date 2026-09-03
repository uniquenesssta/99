import { promises as fsp } from "node:fs";
import type { Stats } from "node:fs";
import {
  canonicalizeAbsolutePath,
  extensionForCanonicalPath,
  isCanonicalPathInsideBoundary,
  sameCanonicalAbsolutePath,
  type CanonicalAbsolutePath,
} from "./pathBoundaryPolicy";

export const DEFAULT_MAX_FONT_READ_BYTES = 80 * 1024 * 1024;

export type FontPathAuthorizationFailureReason =
  | "invalid-path"
  | "unsupported-extension"
  | "path-unavailable"
  | "not-regular-file"
  | "not-directory"
  | "file-too-large"
  | "outside-authorized-roots"
  | "not-main-process-indexed"
  | "root-operation-forbidden";

export type FontPathAuthorizationResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: FontPathAuthorizationFailureReason;
      message: string;
    };

export type AuthorizedFontFile = {
  requestedPath: string;
  realPath: string;
  realComparePath: string;
  ioPath: string;
  size: number;
  source: "authorized-root" | "main-process-index";
  rootPath?: string;
  rootComparePath?: string;
};

export type AuthorizedFontDirectory = {
  requestedPath: string;
  realPath: string;
  realComparePath: string;
  ioPath: string;
  rootPath: string;
  rootComparePath: string;
};

export type MainProcessIndexedFontIdentity = {
  requestedPath: string;
  realPath: string;
  comparePath: string;
};

export type FontPathRootProvider = () =>
  | readonly string[]
  | Promise<readonly string[]>;

export type AuthorizeFontRead = (
  rawPath: unknown,
) => Promise<FontPathAuthorizationResult<AuthorizedFontFile>>;

export type FontPathAuthorizationFileSystem = {
  realpath: (filePath: string) => Promise<string>;
  stat: (
    filePath: string,
  ) => Promise<Pick<Stats, "size" | "isFile" | "isDirectory">>;
};

export type FontPathAuthorizationRuntimeOptions = {
  fontExtensions: ReadonlySet<string>;
  readRoots: FontPathRootProvider;
  watchedRoots: FontPathRootProvider;
  appOwnedRoots: FontPathRootProvider;
  isMainProcessIndexedFont?: (
    identity: MainProcessIndexedFontIdentity,
  ) => boolean | Promise<boolean>;
  maxFontReadBytes?: number;
  fileSystem?: FontPathAuthorizationFileSystem;
};

type ResolvedPath = {
  requested: CanonicalAbsolutePath;
  real: CanonicalAbsolutePath;
};

type ResolvedFontFile = ResolvedPath & {
  size: number;
};

function denied<T>(
  reason: FontPathAuthorizationFailureReason,
  message: string,
): FontPathAuthorizationResult<T> {
  return { ok: false, reason, message };
}

function normalizeExtensions(extensions: ReadonlySet<string>): Set<string> {
  return new Set(
    Array.from(extensions, (extension) =>
      String(extension || "").toLowerCase(),
    ),
  );
}

export function createFontPathAuthorizationRuntime(
  options: FontPathAuthorizationRuntimeOptions,
) {
  const fileSystem = options.fileSystem || {
    realpath: (filePath: string) => fsp.realpath(filePath),
    stat: (filePath: string) => fsp.stat(filePath),
  };
  const fontExtensions = normalizeExtensions(options.fontExtensions);
  const maxFontReadBytes =
    options.maxFontReadBytes ?? DEFAULT_MAX_FONT_READ_BYTES;

  async function resolveRealPath(
    rawPath: unknown,
  ): Promise<FontPathAuthorizationResult<ResolvedPath>> {
    const requested = canonicalizeAbsolutePath(rawPath);
    if (!requested) {
      return denied(
        "invalid-path",
        "路径必须是无控制字符的绝对文件系统路径。",
      );
    }

    try {
      const realPath = await fileSystem.realpath(requested.ioPath);
      const real = canonicalizeAbsolutePath(realPath);
      if (!real || real.flavor !== requested.flavor) {
        return denied("invalid-path", "路径的真实位置无法规范化。");
      }
      return { ok: true, value: { requested, real } };
    } catch {
      return denied(
        "path-unavailable",
        "路径不存在、不可达或无法解析真实位置。",
      );
    }
  }

  async function resolveFontFile(
    rawPath: unknown,
    maximumBytes?: number,
  ): Promise<FontPathAuthorizationResult<ResolvedFontFile>> {
    const requested = canonicalizeAbsolutePath(rawPath);
    if (!requested) {
      return denied(
        "invalid-path",
        "路径必须是无控制字符的绝对文件系统路径。",
      );
    }
    if (!fontExtensions.has(extensionForCanonicalPath(requested))) {
      return denied("unsupported-extension", "路径不是受支持的字体文件。");
    }

    const resolved = await resolveRealPath(rawPath);
    if (!resolved.ok) return resolved;
    if (!fontExtensions.has(extensionForCanonicalPath(resolved.value.real))) {
      return denied(
        "unsupported-extension",
        "路径的真实目标不是受支持的字体文件。",
      );
    }

    try {
      const stat = await fileSystem.stat(resolved.value.real.ioPath);
      if (!stat.isFile()) {
        return denied("not-regular-file", "字体路径不是普通文件。");
      }
      if (maximumBytes !== undefined && stat.size > maximumBytes) {
        return denied(
          "file-too-large",
          `字体文件超过允许的读取上限：${maximumBytes} bytes。`,
        );
      }
      return { ok: true, value: { ...resolved.value, size: stat.size } };
    } catch {
      return denied(
        "path-unavailable",
        "字体文件不存在、不可达或无法读取属性。",
      );
    }
  }

  async function resolveAuthorizedRoots(
    provider: FontPathRootProvider,
  ): Promise<CanonicalAbsolutePath[]> {
    let configuredRoots: readonly string[] = [];
    try {
      configuredRoots = (await provider()) || [];
    } catch {
      return [];
    }

    const roots: CanonicalAbsolutePath[] = [];
    const seen = new Set<string>();
    for (const rawRoot of configuredRoots) {
      const resolved = await resolveRealPath(rawRoot);
      if (!resolved.ok) continue;
      try {
        const stat = await fileSystem.stat(resolved.value.real.ioPath);
        if (!stat.isDirectory()) continue;
      } catch {
        continue;
      }
      const key = `${resolved.value.real.flavor}:${resolved.value.real.comparePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roots.push(resolved.value.real);
    }
    return roots;
  }

  function containingRoot(
    candidate: CanonicalAbsolutePath,
    roots: CanonicalAbsolutePath[],
  ): CanonicalAbsolutePath | undefined {
    return roots
      .filter((root) => isCanonicalPathInsideBoundary(candidate, root))
      .sort(
        (left, right) => right.comparePath.length - left.comparePath.length,
      )[0];
  }

  async function hasMainProcessIndexIdentity(
    file: ResolvedFontFile,
  ): Promise<boolean> {
    if (!options.isMainProcessIndexedFont) return false;
    try {
      return Boolean(
        await options.isMainProcessIndexedFont({
          requestedPath: file.requested.path,
          realPath: file.real.path,
          comparePath: file.real.comparePath,
        }),
      );
    } catch {
      return false;
    }
  }

  async function authorizeFontRead(
    rawPath: unknown,
  ): Promise<FontPathAuthorizationResult<AuthorizedFontFile>> {
    const file = await resolveFontFile(rawPath, maxFontReadBytes);
    if (!file.ok) return file;

    const root = containingRoot(
      file.value.real,
      await resolveAuthorizedRoots(options.readRoots),
    );
    if (root) {
      return {
        ok: true,
        value: {
          requestedPath: file.value.requested.path,
          realPath: file.value.real.path,
          realComparePath: file.value.real.comparePath,
          ioPath: file.value.real.ioPath,
          size: file.value.size,
          source: "authorized-root",
          rootPath: root.path,
          rootComparePath: root.comparePath,
        },
      };
    }

    if (await hasMainProcessIndexIdentity(file.value)) {
      return {
        ok: true,
        value: {
          requestedPath: file.value.requested.path,
          realPath: file.value.real.path,
          realComparePath: file.value.real.comparePath,
          ioPath: file.value.real.ioPath,
          size: file.value.size,
          source: "main-process-index",
        },
      };
    }

    return denied(
      "outside-authorized-roots",
      "字体文件不属于主进程授权根或已索引身份。",
    );
  }

  async function authorizeDirectory(
    rawPath: unknown,
    rootsProvider: FontPathRootProvider,
    allowRoot: boolean,
  ): Promise<FontPathAuthorizationResult<AuthorizedFontDirectory>> {
    const resolved = await resolveRealPath(rawPath);
    if (!resolved.ok) return resolved;

    try {
      const stat = await fileSystem.stat(resolved.value.real.ioPath);
      if (!stat.isDirectory()) {
        return denied("not-directory", "目标路径不是目录。");
      }
    } catch {
      return denied(
        "path-unavailable",
        "目录不存在、不可达或无法读取属性。",
      );
    }

    const root = containingRoot(
      resolved.value.real,
      await resolveAuthorizedRoots(rootsProvider),
    );
    if (!root) {
      return denied(
        "outside-authorized-roots",
        "目录不属于当前主进程授权根。",
      );
    }
    if (!allowRoot && sameCanonicalAbsolutePath(resolved.value.real, root)) {
      return denied(
        "root-operation-forbidden",
        "该操作不能直接修改授权根目录。",
      );
    }

    return {
      ok: true,
      value: {
        requestedPath: resolved.value.requested.path,
        realPath: resolved.value.real.path,
        realComparePath: resolved.value.real.comparePath,
        ioPath: resolved.value.real.ioPath,
        rootPath: root.path,
        rootComparePath: root.comparePath,
      },
    };
  }

  async function authorizeFontMoveSource(
    rawPath: unknown,
  ): Promise<FontPathAuthorizationResult<AuthorizedFontFile>> {
    const file = await resolveFontFile(rawPath);
    if (!file.ok) return file;
    const root = containingRoot(
      file.value.real,
      await resolveAuthorizedRoots(options.watchedRoots),
    );
    if (!root) {
      return denied(
        "outside-authorized-roots",
        "移动源不属于当前 watched root。",
      );
    }
    if (!(await hasMainProcessIndexIdentity(file.value))) {
      return denied(
        "not-main-process-indexed",
        "移动源没有主进程索引身份。",
      );
    }
    return {
      ok: true,
      value: {
        requestedPath: file.value.requested.path,
        realPath: file.value.real.path,
        realComparePath: file.value.real.comparePath,
        ioPath: file.value.real.ioPath,
        size: file.value.size,
        source: "authorized-root",
        rootPath: root.path,
        rootComparePath: root.comparePath,
      },
    };
  }

  async function authorizeFontMoveDestination(
    rawPath: unknown,
  ): Promise<FontPathAuthorizationResult<AuthorizedFontFile>> {
    const file = await resolveFontFile(rawPath);
    if (!file.ok) return file;
    const root = containingRoot(
      file.value.real,
      await resolveAuthorizedRoots(options.watchedRoots),
    );
    if (!root) {
      return denied(
        "outside-authorized-roots",
        "移动后的字体不属于当前 watched root。",
      );
    }
    return {
      ok: true,
      value: {
        requestedPath: file.value.requested.path,
        realPath: file.value.real.path,
        realComparePath: file.value.real.comparePath,
        ioPath: file.value.real.ioPath,
        size: file.value.size,
        source: "authorized-root",
        rootPath: root.path,
        rootComparePath: root.comparePath,
      },
    };
  }

  async function authorizeManagedFontDelete(
    rawPath: unknown,
  ): Promise<FontPathAuthorizationResult<AuthorizedFontFile>> {
    const file = await resolveFontFile(rawPath);
    if (!file.ok) return file;
    const root = containingRoot(
      file.value.real,
      await resolveAuthorizedRoots(options.appOwnedRoots),
    );
    if (!root) {
      return denied(
        "outside-authorized-roots",
        "删除目标不属于应用自有目录。",
      );
    }
    return {
      ok: true,
      value: {
        requestedPath: file.value.requested.path,
        realPath: file.value.real.path,
        realComparePath: file.value.real.comparePath,
        ioPath: file.value.real.ioPath,
        size: file.value.size,
        source: "authorized-root",
        rootPath: root.path,
        rootComparePath: root.comparePath,
      },
    };
  }

  return {
    authorizeFontRead,
    authorizePhysicalFolderParent: (rawPath: unknown) =>
      authorizeDirectory(rawPath, options.watchedRoots, true),
    authorizePhysicalFolderRename: (rawPath: unknown) =>
      authorizeDirectory(rawPath, options.watchedRoots, false),
    authorizeFontMoveSource,
    authorizeFontMoveTarget: (rawPath: unknown) =>
      authorizeDirectory(rawPath, options.watchedRoots, true),
    authorizeFontMoveDestination,
    authorizeManagedFontDelete,
  };
}
