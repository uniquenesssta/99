import { execFile } from "node:child_process";
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime';
import { basename,extname,join,parse,resolve } from "node:path";
import { promisify } from "node:util";
import type { FontItem,SystemInstalledFont } from "../../shared/types";
import type { SystemFontInstallRuntimeDeps } from "./systemFontInstallRuntime";

const execFileAsync = promisify(execFile);

function canOverwriteCurrentUserFontPath(
  filePath: string,
  fontsDir: string,
  fontExtensions: Set<string>,
): boolean {
  const lower = filePath.toLowerCase();
  const root = fontsDir.toLowerCase();
  return lower.startsWith(root) && fontExtensions.has(extname(filePath).toLowerCase());
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

  return normalizedFallback.toLowerCase().startsWith(fontsDir.toLowerCase())
    ? fallbackDest
    : join(fontsDir, basename(fallbackDest));
}

async function isProcessElevated(): Promise<boolean> {
  if (process.platform !== "win32") return true;

  try {
    await execFileAsync("net", ["session"], {
      windowsHide: true,
      timeout: 3500,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function deleteRegistryValueHKLM(name: string): Promise<void> {
  await execFileAsync("reg", ["delete", "HKLM\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Fonts", "/v", name, "/f"], { windowsHide: true });
}

async function unlinkFontFileIfSafe(
  filePath: string,
  allowedRoot: string,
  deps: Pick<SystemFontInstallRuntimeDeps, "fontExtensions">,
): Promise<void> {
  const normalized = filePath.toLowerCase();
  const root = allowedRoot.toLowerCase();

  if (!normalized.startsWith(root)) {
    throw new Error(`unsafe font delete path: ${filePath}`);
  }

  if (!deps.fontExtensions.has(extname(filePath).toLowerCase())) {
    throw new Error(`unsafe font delete extension: ${filePath}`);
  }

  try {
    await fsp.unlink(filePath);
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "";
    if (code !== "ENOENT") throw error;
  }
}

export async function removeSystemFontsWithCurrentPermission(
  hklmNames: string[],
  windowsFontPaths: string[],
  deps: Pick<SystemFontInstallRuntimeDeps, "windowsFontsDir" | "fontExtensions">,
  checkProtection: () => Promise<void>,
  onMutation: () => void,
): Promise<void> {
  if (!hklmNames.length && !windowsFontPaths.length) return;

  const elevated = await isProcessElevated();
  if (!elevated) {
    throw new Error("NEED_ADMIN_PERMISSION");
  }

  for (const name of hklmNames) {
    await checkProtection();
    await deleteRegistryValueHKLM(name);
    onMutation();
  }

  for (const filePath of windowsFontPaths) {
    await checkProtection();
    await unlinkFontFileIfSafe(filePath, deps.windowsFontsDir(), deps);
    onMutation();
  }
}

export function systemUninstallCandidates(
  item: FontItem,
  installed: SystemInstalledFont[],
  deps: Pick<SystemFontInstallRuntimeDeps, "normalizeCompareText">,
): SystemInstalledFont[] {
  const fileName = item.fileName.toLowerCase();
  const normalizedFullName = deps.normalizeCompareText(
    item.fullName || item.family || parse(item.fileName).name,
  );
  const normalizedStem = deps.normalizeCompareText(parse(item.fileName).name);

  return installed.filter((installedFont) => {
    const itemFile = (installedFont.fileName || "").toLowerCase();
    const itemPath = (installedFont.path || "").toLowerCase();
    const reg = deps.normalizeCompareText(installedFont.registryName || "");
    const value = deps.normalizeCompareText(installedFont.value || "");

    if (itemFile && itemFile === fileName) return true;
    if (itemPath && itemPath.endsWith("\\" + fileName)) return true;

    if (normalizedFullName.length >= 4 && reg.includes(normalizedFullName)) return true;
    if (
      normalizedStem.length >= 4 &&
      (reg.includes(normalizedStem) || value.includes(normalizedStem))
    ) {
      return true;
    }

    return false;
  });
}
