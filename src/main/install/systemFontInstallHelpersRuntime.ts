import { isPathInsideAbsoluteBoundary } from "../path/pathBoundaryPolicy";
import { basename,extname,join,resolve } from "node:path";

import type { FontItem,SystemInstalledFont } from "../../shared/types";
import type { SystemFontInstallRuntimeDeps } from "./systemFontInstallRuntime";



function canOverwriteCurrentUserFontPath(
  filePath: string,
  fontsDir: string,
  fontExtensions: Set<string>,
): boolean {
  return isPathInsideAbsoluteBoundary(filePath, fontsDir) && fontExtensions.has(extname(filePath).toLowerCase());
}

export function installOverwriteTarget(
  item: FontItem,
  installed: SystemInstalledFont[],
  fontsDir: string,
  fallbackDest: string,
  deps: Pick<SystemFontInstallRuntimeDeps, "registryNameFor" | "normalizePathForCacheCompare" | "fontExtensions">,
): string {
  const regName = deps.registryNameFor(item).toLowerCase();
  const fileName = basename(fallbackDest).toLowerCase();
  const normalizedFallback = deps.normalizePathForCacheCompare(resolve(fallbackDest));

  const exactRegistry = installed.find(
    (record) =>
      record.source === "HKCU" &&
      record.path &&
      record.registryName.toLowerCase() === regName &&
      canOverwriteCurrentUserFontPath(record.path, fontsDir, deps.fontExtensions),
  );

  if (exactRegistry?.path) return exactRegistry.path;

  const exactFileName = installed.find(
    (record) =>
      record.path &&
      canOverwriteCurrentUserFontPath(record.path, fontsDir, deps.fontExtensions) &&
      basename(record.path).toLowerCase() === fileName,
  );

  if (exactFileName?.path) return exactFileName.path;

  return isPathInsideAbsoluteBoundary(normalizedFallback, fontsDir)
    ? fallbackDest
    : join(fontsDir, basename(fallbackDest));
}
