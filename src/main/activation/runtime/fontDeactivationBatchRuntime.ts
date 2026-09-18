import { createFontActivationTraceRuntime } from "./fontActivationTraceRuntime";
import type {
  FontActivationBatchResult,
  FontItem,
} from "../../../shared/types";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontActivationCleanupRuntime } from "./fontActivationCleanupRuntime";
import { createFontActivationInstallStatusRuntime, uniqueFontItems } from "./fontActivationInstallStatusRuntime";
import {
  fontDeactivationPathKey,
  fontDeactivationSettlementFailureMessage,
  settleFontDeactivationRecords,
} from "./fontDeactivationSettlementRuntime";
import type { DeactivationRecordTarget } from "./fontDeactivationSettlementRuntime";
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
    scheduleBackgroundFontRefreshTail,
    appendStartupLog,
  } = deps;
  const { activationTraceStep } = createFontActivationTraceRuntime(deps);
  const { queueTemporaryFontFileDeletes } = cleanupRuntime;

  async function runDeactivationBatch(
    items: FontItem[],
  ): Promise<FontActivationBatchResult> {
    ensureWindows();
    const unique = uniqueFontItems(items).slice(0, 1000);
    const results: FontActivationBatchResult["results"] = {};
    const state = await activationTraceStep("deactivate:session-load", undefined, () => loadTemporaryActiveFonts());
    const targetIds = new Set(unique.map((item) => item.id));
    const targetPaths = new Set(
      unique.map((item) => fontDeactivationPathKey(item.path)),
    );
    const targets = state.records.filter(
      (record) =>
        targetIds.has(record.fontId) ||
        targetPaths.has(fontDeactivationPathKey(record.sourcePath)),
    );
    const recordsByItemId = new Map<string, TemporaryActiveFontRecord[]>();
    const settlementTargets: DeactivationRecordTarget[] = [];

    for (const record of targets) {
      const item =
        unique.find((candidate) => candidate.id === record.fontId) ||
        unique.find(
          (candidate) =>
            fontDeactivationPathKey(candidate.path) ===
            fontDeactivationPathKey(record.sourcePath),
        );
      if (!item) continue;
      const itemRecords = recordsByItemId.get(item.id) || [];
      itemRecords.push(record);
      recordsByItemId.set(item.id, itemRecords);
      settlementTargets.push({ item, record });
    }

    for (const item of unique) {
      if (recordsByItemId.has(item.id)) continue;
      results[item.id] = {
        id: item.id,
        fileName: item.fileName,
        ok: true,
        temporaryActivated: false,
        message:
          "没有找到这个字体的临时安装记录；如果它是永久安装字体，不会被移除。",
      };
    }

    const settlements = await settleFontDeactivationRecords(
      settlementTargets,
      {
        removeFontResourceSessionBatch,
        deleteFontRegistryValuesHKCUBatch,
        queueTemporaryFontFileDeletes,
        appendStartupLog,
      },
    );
    const committedRecords = new Set(
      settlements
        .filter((settlement) => settlement.fileQueue.ok)
        .map((settlement) => settlement.record),
    );
    if (committedRecords.size) {
      const remaining = state.records.filter(
        (record) => !committedRecords.has(record),
      );
      await activationTraceStep("deactivate:session-save", undefined, () => saveTemporaryActiveFonts({ version: 1, records: remaining }));
    }

    for (const item of unique) {
      const itemSettlements = settlements.filter(
        (settlement) => settlement.item.id === item.id,
      );
      if (!itemSettlements.length) continue;
      const failedSettlements = itemSettlements.filter(
        (settlement) => !settlement.fileQueue.ok,
      );
      if (failedSettlements.length) {
        results[item.id] = {
          id: item.id,
          fileName: item.fileName,
          ok: false,
          temporaryActivated: true,
          message: `取消激活未完成：${failedSettlements
            .map(
              (settlement) =>
                `${settlement.record.fileName || settlement.record.installPath}：${fontDeactivationSettlementFailureMessage(settlement)}`,
            )
            .join("；")}`,
        };
      } else {
        results[item.id] = {
          id: item.id,
          fileName: item.fileName,
          ok: true,
          temporaryActivated: false,
          message: "已取消激活；临时字体文件已转入后台清理。",
        };
      }
    }

    const reconciledItems = unique.filter(item => results[item.id]?.ok && results[item.id]?.temporaryActivated === false);
    try {
      const reconciled = await createFontActivationInstallStatusRuntime(deps).reconcileDeactivatedInstallStatus(reconciledItems, [...committedRecords].map(record => record.installPath));
      for (const item of reconciledItems) {
        const status = reconciled[item.id];
        if (status?.by === 'managed' || status?.by === 'both') {
          results[item.id] = { ...results[item.id], ok: false, temporaryActivated: true,
            message: '系统仍检测到临时激活，但本机记录未能完成对应清理；已保留实际状态。' };
        }
      }
    } catch (error) {
      appendStartupLog(`deactivation status reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
      for (const item of reconciledItems) {
        results[item.id] = { ...results[item.id], ok: false,
          message: '临时记录处理已完成，但系统安装状态核对失败，请重试。' };
      }
    }
    if (settlements.some((settlement) => settlement.resource.ok)) {
      scheduleBackgroundFontRefreshTail("batch-deactivate-tail", 80);
    }

    const deactivated = unique.filter(item => recordsByItemId.has(item.id) && results[item.id]?.ok).length;
    const failed = unique.filter(item => !results[item.id]?.ok).length;
    const skippedInactive = unique.filter(
      (item) => !recordsByItemId.has(item.id) && results[item.id]?.ok,
    ).length;
    appendStartupLog(
      `deactivation batch summary: total=${unique.length}, records=${settlements.length}, deactivated=${deactivated}, skippedInactive=${skippedInactive}, failed=${failed}`,
    );
    return {
      ok: failed === 0,
      activated: 0,
      deactivated,
      skippedInstalled: 0,
      skippedAlreadyActive: skippedInactive,
      failed,
      results,
      message: `批量取消激活完成：移除临时激活 ${deactivated} 项，未找到临时记录 ${skippedInactive} 个，失败 ${failed} 个。`,
    };
  }

  function deactivateFontSessionsBatch(items: FontItem[]): Promise<FontActivationBatchResult> {
    return activationTraceStep("deactivate:batch-total", undefined, () => runDeactivationBatch(items));
  }

  return { deactivateFontSessionsBatch };
}

export type FontDeactivationBatchRuntime = ReturnType<
  typeof createFontDeactivationBatchRuntime
>;
