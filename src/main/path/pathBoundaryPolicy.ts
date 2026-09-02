import { posix,win32 } from "node:path";

export type AbsolutePathFlavor = "windows" | "posix";

export type CanonicalAbsolutePath = {
  flavor: AbsolutePathFlavor;
  path: string;
  ioPath: string;
  comparePath: string;
};

const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F]/;
const WINDOWS_DRIVE_ABSOLUTE_PATTERN = /^[a-zA-Z]:\\/;
const WINDOWS_UNC_ABSOLUTE_PATTERN = /^\\\\[^\\]+\\[^\\]+(?:\\|$)/;

function canonicalizeWindowsAbsolutePath(
  rawPath: string,
): CanonicalAbsolutePath | null {
  const nativePath = rawPath.replaceAll("/", "\\");
  let comparisonPath = nativePath;
  let ioPath = nativePath;

  if (/^\\\\\?\\UNC\\/i.test(nativePath)) {
    comparisonPath = `\\\\${nativePath.slice(8)}`;
    ioPath = win32.normalize(nativePath);
  } else if (/^\\\\\?\\[a-zA-Z]:\\/.test(nativePath)) {
    comparisonPath = nativePath.slice(4);
    ioPath = win32.normalize(nativePath);
  } else if (/^\\\\[.?]\\/.test(nativePath)) {
    return null;
  }

  const normalized = win32.normalize(comparisonPath);
  if (
    !WINDOWS_DRIVE_ABSOLUTE_PATTERN.test(normalized) &&
    !WINDOWS_UNC_ABSOLUTE_PATTERN.test(normalized)
  ) {
    return null;
  }

  return {
    flavor: "windows",
    path: normalized,
    ioPath: /^\\\\\?\\/i.test(nativePath) ? ioPath : normalized,
    comparePath: normalized.toLowerCase(),
  };
}

export function canonicalizeAbsolutePath(
  rawPath: unknown,
): CanonicalAbsolutePath | null {
  if (
    typeof rawPath !== "string" ||
    !rawPath ||
    CONTROL_CHARACTER_PATTERN.test(rawPath)
  ) {
    return null;
  }

  if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/\/)/.test(rawPath)) {
    return canonicalizeWindowsAbsolutePath(rawPath);
  }

  if (!posix.isAbsolute(rawPath)) return null;
  const normalized = posix.normalize(rawPath);
  return {
    flavor: "posix",
    path: normalized,
    ioPath: normalized,
    comparePath: normalized,
  };
}

export function sameCanonicalAbsolutePath(
  left: CanonicalAbsolutePath,
  right: CanonicalAbsolutePath,
): boolean {
  return left.flavor === right.flavor && left.comparePath === right.comparePath;
}

export function isCanonicalPathInsideBoundary(
  candidate: CanonicalAbsolutePath,
  root: CanonicalAbsolutePath,
): boolean {
  if (candidate.flavor !== root.flavor) return false;

  const pathApi = candidate.flavor === "windows" ? win32 : posix;
  const relativePath = pathApi.relative(root.comparePath, candidate.comparePath);
  if (!relativePath) return true;
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${pathApi.sep}`)
  ) {
    return false;
  }
  return !pathApi.isAbsolute(relativePath);
}

export function isPathInsideAbsoluteBoundary(
  candidatePath: unknown,
  rootPath: unknown,
): boolean {
  const candidate = canonicalizeAbsolutePath(candidatePath);
  const root = canonicalizeAbsolutePath(rootPath);
  return Boolean(
    candidate && root && isCanonicalPathInsideBoundary(candidate, root),
  );
}

export function extensionForCanonicalPath(
  pathValue: CanonicalAbsolutePath,
): string {
  return (pathValue.flavor === "windows" ? win32 : posix)
    .extname(pathValue.path)
    .toLowerCase();
}
