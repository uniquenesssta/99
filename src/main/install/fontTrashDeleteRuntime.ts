import { shell } from "electron";
import { promises as fsp } from "node:fs";
import { basename,extname,resolve } from "node:path";
import type { FontDeleteResult,FontItem } from "../../shared/types";
import { withSharedLeaseLock } from "../storage/runtime/sharedLeaseLockRuntime";
import type { SystemFontInstallRuntimeDeps } from "./systemFontInstallRuntime";

export async function deleteFontFilesToTrashRuntime(
  items: FontItem[],
  watchedFolders: string[],
  deps: Pick<SystemFontInstallRuntimeDeps, "fontExtensions" | "isCleanWindowsDefaultItem" | "isPathInsideAnyRoot" | "appendStartupLog">,
): Promise<FontDeleteResult> {
  const deletedIds: string[] = [];
  const failed: FontDeleteResult["failed"] = [];
  let skippedProtected = 0;
  let skippedInstalled = 0;
  let skippedUnsafe = 0;

  for (const item of items || []) {
    if (!item?.id || !item.path) {
      skippedUnsafe += 1;
      continue;
    }

    if (item.deleteProtected || deps.isCleanWindowsDefaultItem(item)) {
      skippedProtected += 1;
      continue;
    }

    if (item.systemInstalled || item.systemImported || item.active) {
      skippedInstalled += 1;
      continue;
    }

    const resolvedPath = resolve(item.path);
    if (
      !deps.fontExtensions.has(extname(resolvedPath).toLowerCase()) ||
      !deps.isPathInsideAnyRoot(resolvedPath, watchedFolders || [])
    ) {
      skippedUnsafe += 1;
      continue;
    }

    try {
      await withSharedLeaseLock({
        operation: 'delete-font',
        resourcePath: resolvedPath,
        roots: watchedFolders || [],
        appendStartupLog: deps.appendStartupLog
      }, async () => {
        await fsp.access(resolvedPath);
        await shell.trashItem(resolvedPath);
      });
      deletedIds.push(item.id);
    } catch (error) {
      failed.push({
        id: item.id,
        fileName: item.fileName || basename(resolvedPath),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const firstFailureMessage = failed[0]?.message || "";
  const parts = [
    `删除到回收站 ${deletedIds.length} 个`,
    skippedProtected ? `跳过保护 ${skippedProtected} 个` : "",
    skippedInstalled ? `跳过已安装/已激活 ${skippedInstalled} 个` : "",
    skippedUnsafe ? `跳过非监听目录或不安全路径 ${skippedUnsafe} 个` : "",
    failed.length ? `失败 ${failed.length} 个` : "",
    firstFailureMessage ? `失败原因：${firstFailureMessage}` : "",
  ].filter(Boolean);

  return {
    ok: failed.length === 0,
    deletedIds,
    deleted: deletedIds.length,
    skippedProtected,
    skippedInstalled,
    skippedUnsafe,
    failed,
    message: parts.join("，") || "没有可删除的字体文件。",
  };
}
