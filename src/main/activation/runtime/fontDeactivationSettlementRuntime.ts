import { createFontActivationTraceRuntime } from "./fontActivationTraceRuntime";
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
  verifyManagedRecord: (record: TemporaryActiveFontRecord) => Promise<boolean>;
  persistRecordStages?: (records: TemporaryActiveFontRecord[], stage: TemporaryActiveFontRecord['stage']) => Promise<void>;
  persistRecordStage: (record: TemporaryActiveFontRecord, stage: TemporaryActiveFontRecord['stage']) => Promise<void>;
  removeFontResourceSessionBatch: (
    fontPaths: string[],
  ) => Promise<FontResourceBatchResult>;
  deleteManagedRegistryRecords: (records: TemporaryActiveFontRecord[]) => Promise<void>;
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
  return String(filePath || "").replace(/[\\/]+/g, "\\").replace(/\\+$/g, "").toLowerCase();
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
  const { activationTraceStep } = createFontActivationTraceRuntime(deps);
  const settlements = targets.map<DeactivationRecordSettlement>((target) => ({
    ...target,
    resource: pendingStep("字体资源移除尚未执行。"),
    registry: pendingStep("等待字体资源移除成功。"),
    fileQueue: pendingStep("等待注册表清理成功。"),
  }));

  const persist = async (items: DeactivationRecordSettlement[], stage: TemporaryActiveFontRecord['stage']): Promise<void> => {
    if (deps.persistRecordStages) await deps.persistRecordStages(items.map(item => item.record), stage);
    else for (const item of items) await deps.persistRecordStage(item.record, stage);
  };
  const eligible: DeactivationRecordSettlement[] = [];
  for (const settlement of settlements) {
    try {
      await deps.verifyManagedRecord(settlement.record);
      if (settlement.record.stage === 'registry-removal-pending' || settlement.record.stage === 'file-pending') {
        settlement.resource = successfulStep('资源已在之前的清理阶段移除。');
        if (settlement.record.stage === 'file-pending') settlement.registry = successfulStep('注册表已在之前的清理阶段清理。');
      } else {
        eligible.push(settlement);
      }
    } catch (error) { settlement.resource = failedStep(error, '受管身份核验失败。'); }
  }
  try { await persist(eligible, 'resource-removal-pending'); }
  catch (error) {
    for (const settlement of eligible) settlement.resource = failedStep(error, '资源移除意图保存失败。');
    eligible.length = 0;
  }
  let resourceBatchError: unknown = null;
  let resourceResults: FontResourceBatchResult = {};
  if (eligible.length) {
    try {
      resourceResults = await activationTraceStep("deactivate:resource-remove", undefined, () => deps.removeFontResourceSessionBatch(
        eligible.map((settlement) => settlement.record.installPath),
      ));
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
  const removed: DeactivationRecordSettlement[] = [];
  for (const settlement of eligible) {
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
      removed.push(settlement);
      settlement.resource = successfulStep(entry.message || '字体资源已移除。');
    }
  }

  try { await persist(removed, 'registry-removal-pending'); }
  catch (error) { for (const settlement of removed) settlement.resource = failedStep(error, '资源移除进度保存失败。'); }

  const registryCandidates = settlements.filter(
    (settlement) => settlement.resource.ok && !settlement.registry.ok,
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
  const registryGroups = [...registryCandidatesByName.values()];
  const registryRecords = registryGroups.map(candidates => candidates[0].record);
  const settleRegistryGroup = (candidates: DeactivationRecordSettlement[], error?: unknown): void => {
    for (const settlement of candidates) {
      settlement.registry = error === undefined
        ? successfulStep("注册表记录已清理。")
        : failedStep(error, "字体注册表批量清理失败。");
    }
  };
  if (registryRecords.length) {
    await activationTraceStep("deactivate:registry-settlement", undefined, async () => {
      try {
        // The native owner re-verifies durable record path + identity + registry value
        // immediately before deletion. No generic arbitrary-name registry delete is used here.
        await activationTraceStep("deactivate:registry-batch", undefined, () => deps.deleteManagedRegistryRecords(registryRecords));
        registryGroups.forEach(candidates => settleRegistryGroup(candidates));
      } catch (error) {
        if (registryRecords.length === 1) {
          settleRegistryGroup(registryGroups[0], error ?? "注册表清理失败。");
          return;
        }
        // Only the same ownership-checked idempotent delete is isolated per record.
        // Resources are never removed twice.
        for (const candidates of registryGroups) {
          try {
            await activationTraceStep("deactivate:registry-isolate", candidates[0].item.id, () => deps.deleteManagedRegistryRecords([candidates[0].record]));
            settleRegistryGroup(candidates);
          } catch (entryError) {
            settleRegistryGroup(candidates, entryError ?? "注册表清理失败。");
          }
        }
      }
    });
  }

  const registryRemoved = settlements.filter(settlement => settlement.resource.ok && settlement.registry.ok);
  try { await persist(registryRemoved, 'file-pending'); }
  catch (error) { for (const settlement of registryRemoved) settlement.registry = failedStep(error, '注册表清理进度保存失败。'); }

  const fileQueueCandidates = settlements.filter(
    (settlement) => settlement.resource.ok && settlement.registry.ok,
  );
  if (fileQueueCandidates.length) {
    try {
      const queueResults = await activationTraceStep("deactivate:file-queue", undefined, () => deps.queueTemporaryFontFileDeletes(
        fileQueueCandidates.map((settlement) => settlement.record),
        "batch-deactivate",
      ));
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
