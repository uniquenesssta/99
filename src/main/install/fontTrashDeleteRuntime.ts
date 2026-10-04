import { readFontMutationIdentity } from "./fontUninstallPlanRuntime";
import { FontProtectionError } from './fontProtectionAuthorityRuntime';
import { randomUUID } from "node:crypto";
import { executeSharedFile, sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime';
import { basename,extname,resolve } from "node:path";
import type { FontDeleteResult,FontItem } from "../../shared/types";
import { withSharedLeaseLock } from "../storage/runtime/sharedLeaseLockRuntime";
import type { SystemFontInstallRuntimeDeps } from "./systemFontInstallRuntime";

export async function deleteFontFilesToTrashRuntime(
  items: FontItem[],
  watchedFolders: string[],
  deps: Pick<SystemFontInstallRuntimeDeps, "fontExtensions" | "withFontProtection" | "isPathInsideAnyRoot" | "appendStartupLog"> & { prepareSourceDelete: (item: FontItem) => Promise<void> },
): Promise<FontDeleteResult> {
  const operationId = randomUUID();
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

    const resolvedPath = resolve(item.path);
    if (
      !deps.fontExtensions.has(extname(resolvedPath).toLowerCase())
    ) {
      skippedUnsafe += 1;
      continue;
    }

    try {
      const identity = await readFontMutationIdentity(item.path);
      await deps.withFontProtection([item, { ...item, path: identity.path }], async () => undefined);
      await deps.prepareSourceDelete(item);
      await deps.withFontProtection([item, { ...item, path: identity.path }], async checkProtection => {
        await withSharedLeaseLock({
          operation: 'delete-font',
          resourcePath: resolvedPath,
          roots: watchedFolders || [],
          appendStartupLog: deps.appendStartupLog
        }, async () => {
          await fsp.access(resolvedPath);
          const current = await readFontMutationIdentity(item.path);
          if (current.path !== identity.path || current.sha256 !== identity.sha256) throw new Error("源文件已变化，未移入回收站。");
          await checkProtection();
          deps.appendStartupLog(`font delete: operation=${operationId}, target=${item.id}, stage=recycle`);
          // The existing isolated recycle operation is recycle-only and has no
          // autonomous UAC prompt that could outlive the protection check.
          await executeSharedFile({ operation:'trash',path:resolvedPath });
          try { await fsp.access(resolvedPath); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
          throw new Error('回收站操作未确认文件移除；未标记删除成功。');
        });
      });
      deletedIds.push(item.id);
      deps.appendStartupLog(`font delete: operation=${operationId}, target=${item.id}, stage=verified, ok=true`);
    } catch (error) {
      deps.appendStartupLog(`font delete: operation=${operationId}, target=${item.id}, stage=failed, native=${(error as NodeJS.ErrnoException).code || "unknown"}, detail=${String(error)}`);
      if (error instanceof FontProtectionError && error.reason === 'protected') { skippedProtected += 1; continue; }
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
    skippedUnsafe ? `跳过不安全路径 ${skippedUnsafe} 个` : "",
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
