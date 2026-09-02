import { resolve } from "node:path";
import { isIgnoredInternalDirectoryName } from "../cache/cachePaths";
import {
  canonicalizeAbsolutePath,
  isPathInsideAbsoluteBoundary,
} from "./pathBoundaryPolicy";
import { canonicalWatchedFolderPath,dedupeWatchedFolderRoots,watchedFolderCompareKey } from "./watchedFolderCanonicalRuntime";

export {
  canonicalizeAbsolutePath,
  extensionForCanonicalPath,
  isCanonicalPathInsideBoundary,
  isPathInsideAbsoluteBoundary,
  sameCanonicalAbsolutePath,
} from "./pathBoundaryPolicy";

export type PathPolicyLogger = (message: string) => void;

export function isIgnoredInternalFolderPath(folderPath: string): boolean {
  const parts = String(folderPath || "")
    .replaceAll("\\", "/")
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.some((part) => isIgnoredInternalDirectoryName(part));
}

export function uniqueResolvedFolders(folders: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const rawFolder of folders || []) {
    if (!rawFolder) continue;
    const folder = canonicalWatchedFolderPath(rawFolder);
    const key = watchedFolderCompareKey(folder);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(folder);
  }

  return dedupeWatchedFolderRoots(result);
}

export function normalizeWatchedFontFolders(
  folders: string[],
  appendLog?: PathPolicyLogger,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const rawFolder of folders || []) {
    if (!rawFolder) continue;
    const folder = canonicalWatchedFolderPath(rawFolder, appendLog);
    if (isIgnoredInternalFolderPath(folder)) {
      appendLog?.(
        `ignored internal cache folder from watched folders: ${folder}`,
      );
      continue;
    }
    const key = watchedFolderCompareKey(folder);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(folder);
  }

  return dedupeWatchedFolderRoots(result, appendLog);
}

export function findBestWatchedRootForFile(
  filePath: string,
  folders: string[],
): string | null {
  const resolvedFile = canonicalizeAbsolutePath(filePath)?.path || resolve(filePath);
  let best: string | null = null;

  for (const folder of folders || []) {
    if (!folder) continue;
    const resolvedFolder =
      canonicalizeAbsolutePath(folder)?.path || resolve(folder);
    if (!isPathInsideAbsoluteBoundary(resolvedFile, resolvedFolder)) continue;
    if (!best || resolvedFolder.length > best.length) best = resolvedFolder;
  }

  return best;
}

export function isPathInsideAnyRoot(
  filePath: string,
  roots: string[],
): boolean {
  const file = canonicalizeAbsolutePath(filePath)?.path || resolve(filePath);
  return (roots || []).some((root) => {
    const normalizedRoot = canonicalizeAbsolutePath(root)?.path || resolve(root);
    return isPathInsideAbsoluteBoundary(file, normalizedRoot);
  });
}
