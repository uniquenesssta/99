import type { FontItem } from "../../../shared/types";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontResourceBatchResult } from "../../windows/runtime/fontRuntimeTypes";
import type { TemporaryFontDeleteQueueResult } from "../temporaryFontDeleteQueue";

export type DeactivationStepResult = {
  ok: boolean;
  message: string;
};

export type DeactivationRecordTarget = {
  item: FontItem;
  record: TemporaryActiveFontRecord;
};

export type DeactivationRecordSettlement = DeactivationRecordTarget & {
  resource: DeactivationStepResult;
  registry: DeactivationStepResult;
  fileQueue: DeactivationStepResult;
};

export interface FontDeactivationSettlementDeps {
  removeFontResourceSessionBatch: (
    fontPaths: string[],
  ) => Promise<FontResourceBatchResult>;
  deleteFontRegistryValuesHKCUBatch: (names: string[]) => Promise<unknown>;
  queueTemporaryFontFileDeletes: (
    records: TemporaryActiveFontRecord[],
    reason: string,
  ) => Promise<TemporaryFontDeleteQueueResult>;
  appendStartupLog: (message: string) => void;
}

function pendingStep(message: string): DeactivationStepResult {
  return { ok: false, message };
}

function successfulStep(message: string): DeactivationStepResult {
  return { ok: true, message };
}

function failedStep(error: unknown, fallback: string): DeactivationStepResult {
  return {
    ok: false,
    message:
      error instanceof Error
        ? error.message
        : String(error || fallback),
  };
}

export function fontDeactivationPathKey(filePath: string): string {
  return filePath.toLowerCase();
}

export function fontDeactivationSettlementFailureMessage(
  settlement: DeactivationRecordSettlement,
): string {
  if (!settlement.resource.ok) {
    return `字体资源移除失败：${settlement.resource.message}`;
  }
  if (!settlement.registry.ok) {
    return `注册表清理失败：${settlement.registry.message}`;
  }
  return `文件清理入队失败：${settlement.fileQueue.message}`;
}

export async function settleFontDeactivationRecords(
  targets: DeactivationRecordTarget[],
  deps: FontDeactivationSettlementDeps,
): Promise<DeactivationRecordSettlement[]> {
  const settlements = targets.map<DeactivationRecordSettlement>((target) => ({
    ...target,
    resource: pendingStep("字体资源移除尚未执行。"),
    registry: pendingStep("等待字体资源移除成功。"),
    fileQueue: pendingStep("等待注册表清理成功。"),
  }));

  let resourceBatchError: unknown = null;
  let resourceResults: FontResourceBatchResult = {};
  if (settlements.length) {
    try {
      resourceResults = await deps.removeFontResourceSessionBatch(
        settlements.map((settlement) => settlement.record.installPath),
      );
    } catch (error) {
      resourceBatchError = error;
      deps.appendStartupLog(
        `batch deactivate resource remove failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const resourceResultsByPath = new Map(
    Object.entries(resourceResults).map(([filePath, entry]) => [
      fontDeactivationPathKey(filePath),
      entry,
    ]),
  );
  for (const settlement of settlements) {
    if (resourceBatchError) {
      settlement.resource = failedStep(
        resourceBatchError,
        "字体资源批量移除失败。",
      );
      continue;
    }
    const entry = resourceResultsByPath.get(
      fontDeactivationPathKey(settlement.record.installPath),
    );
    if (!entry) {
      settlement.resource = pendingStep(
        `批量结果缺少 ${settlement.record.installPath}。`,
      );
    } else if (!entry.ok) {
      settlement.resource = pendingStep(
        entry.message || "RemoveFontResourceEx 批量移除失败。",
      );
    } else {
      settlement.resource = successfulStep(
        entry.message || "字体资源已移除。",
      );
    }
  }

  const registryCandidates = settlements.filter(
    (settlement) => settlement.resource.ok,
  );
  const registryCandidatesByName = new Map<
    string,
    DeactivationRecordSettlement[]
  >();
  for (const settlement of registryCandidates) {
    const registryName = settlement.record.registryName;
    if (!registryName) {
      settlement.registry = successfulStep("没有需要清理的注册表记录。");
      continue;
    }
    const registryKey = registryName.toLowerCase();
    const grouped = registryCandidatesByName.get(registryKey) || [];
    grouped.push(settlement);
    registryCandidatesByName.set(registryKey, grouped);
  }
  for (const candidates of registryCandidatesByName.values()) {
    const registryName = candidates[0].record.registryName;
    try {
      await deps.deleteFontRegistryValuesHKCUBatch([registryName]);
      for (const settlement of candidates) {
        settlement.registry = successfulStep("注册表记录已清理。");
      }
    } catch (error) {
      deps.appendStartupLog(
        `batch deactivate registry delete failed: ${registryName} ${error instanceof Error ? error.message : String(error)}`,
      );
      for (const settlement of candidates) {
        settlement.registry = failedStep(error, "字体注册表批量清理失败。");
      }
    }
  }

  const fileQueueCandidates = settlements.filter(
    (settlement) => settlement.resource.ok && settlement.registry.ok,
  );
  if (fileQueueCandidates.length) {
    try {
      const queueResults = await deps.queueTemporaryFontFileDeletes(
        fileQueueCandidates.map((settlement) => settlement.record),
        "batch-deactivate",
      );
      const queueResultsByPath = new Map(
        Object.entries(queueResults).map(([filePath, entry]) => [
          fontDeactivationPathKey(filePath),
          entry,
        ]),
      );
      for (const settlement of fileQueueCandidates) {
        const entry = queueResultsByPath.get(
          fontDeactivationPathKey(settlement.record.installPath),
        );
        if (entry?.ok) {
          settlement.fileQueue = successfulStep(entry.message);
        } else {
          settlement.fileQueue = pendingStep(
            entry?.message || "持久删除队列缺少目标结果。",
          );
        }
      }
    } catch (error) {
      deps.appendStartupLog(
        `batch deactivate file queue failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      for (const settlement of fileQueueCandidates) {
        settlement.fileQueue = failedStep(
          error,
          "临时字体文件写入持久删除队列失败。",
        );
      }
    }
  }

  return settlements;
}
