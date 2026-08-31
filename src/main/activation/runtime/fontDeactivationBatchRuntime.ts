import type { FontActivationBatchResult,FontItem,InstallCompareResult } from "../../../shared/types";
import type { FontActivationCleanupRuntime } from "./fontActivationCleanupRuntime";
import { uniqueFontItems } from "./fontActivationInstallStatusRuntime";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";

export function createFontDeactivationBatchRuntime(
  deps: FontActivationRuntimeDeps,
  cleanupRuntime: FontActivationCleanupRuntime,
) {
  const {
    ensureWindows,
    loadTemporaryActiveFonts,
    saveTemporaryActiveFonts,
    removeFontResourceSessionBatch,
    deleteFontRegistryValuesHKCUBatch,
    scheduleActivationInstallStatusSave,
    scheduleBackgroundFontRefreshTail,
    appendStartupLog,
  } = deps;
  const { queueTemporaryFontFileDeletes } = cleanupRuntime;

  async function deactivateFontSessionsBatch(
    items: FontItem[],
  ): Promise<FontActivationBatchResult> {
    ensureWindows();
    const unique = uniqueFontItems(items).slice(0, 1000);
    const results: FontActivationBatchResult["results"] = {};
    const state = await loadTemporaryActiveFonts();
    const targetIds = new Set(unique.map((item) => item.id));
    const targetPaths = new Set(unique.map((item) => item.path.toLowerCase()));
    const targets = state.records.filter(
      (record) =>
        targetIds.has(record.fontId) ||
        targetPaths.has(record.sourcePath.toLowerCase()),
    );
    const targetRecordIds = new Set(
      targets.map((record) => `${record.fontId}\u0000${record.installPath}`),
    );
    for (const item of unique) {
      const itemTargets = targets.filter(
        (record) =>
          record.fontId === item.id ||
          record.sourcePath.toLowerCase() === item.path.toLowerCase(),
      );
      if (!itemTargets.length) {
        results[item.id] = {
          id: item.id,
          fileName: item.fileName,
          ok: true,
          temporaryActivated: false,
          message:
            "没有找到这个字体的临时安装记录；如果它是永久安装字体，不会被移除。",
        };
      }
    }

    if (targets.length) {
      await removeFontResourceSessionBatch(
        targets.map((record) => record.installPath),
      ).catch((error) =>
        appendStartupLog(
          `batch deactivate resource remove failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      await deleteFontRegistryValuesHKCUBatch(
        targets.map((record) => record.registryName),
      ).catch((error) =>
        appendStartupLog(
          `batch deactivate registry delete failed: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }

    let deactivated = 0;
    let failed = 0;
    if (targets.length) {
      await queueTemporaryFontFileDeletes(targets, "batch-deactivate");
    }
    for (const record of targets) {
      const item = unique.find(
        (font) =>
          font.id === record.fontId ||
          font.path.toLowerCase() === record.sourcePath.toLowerCase(),
      );
      deactivated += 1;
      if (item) {
        results[item.id] = {
          id: item.id,
          fileName: item.fileName,
          ok: true,
          temporaryActivated: false,
          message: "已取消激活；临时字体文件已转入后台清理。",
        };
      }
    }

    const remaining = state.records.filter((record) => {
      const recordKey = `${record.fontId}\u0000${record.installPath}`;
      return !targetRecordIds.has(recordKey);
    });
    await saveTemporaryActiveFonts({ version: 1, records: remaining });
    if (targets.length) {
      const deactivatedStatusUpdates: Record<string, InstallCompareResult> = {};
      const deactivatedItemsById = new Map<string, FontItem>();
      for (const item of unique) {
        const result = results[item.id];
        if (!result?.ok || result.temporaryActivated !== false) continue;
        deactivatedStatusUpdates[item.id] = {
          installed: false,
          by: "none",
          matches: [],
        };
        deactivatedItemsById.set(item.id, item);
      }
      if (Object.keys(deactivatedStatusUpdates).length) {
        scheduleActivationInstallStatusSave(
          deactivatedStatusUpdates,
          deactivatedItemsById,
          "batch-deactivate",
        );
      }
      scheduleBackgroundFontRefreshTail("batch-deactivate-tail", 80);
    }

    return {
      ok: failed === 0,
      activated: 0,
      deactivated,
      skippedInstalled: 0,
      skippedAlreadyActive: unique.length - targets.length,
      failed,
      results,
      message: `批量取消激活完成：移除临时激活 ${deactivated} 项，未找到临时记录 ${Math.max(0, unique.length - targets.length)} 个，失败 ${failed} 个。`,
    };
  }

  return { deactivateFontSessionsBatch };
}

export type FontDeactivationBatchRuntime = ReturnType<typeof createFontDeactivationBatchRuntime>;
