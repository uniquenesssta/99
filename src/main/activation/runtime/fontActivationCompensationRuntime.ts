import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontActivationCleanupRuntime } from "./fontActivationCleanupRuntime";
import {
  createFontActivationCompensationQueue,
  type FontActivationCompensationStages,
  type PendingFontActivationCompensation,
} from "./fontActivationCompensationQueue";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";

export type FontActivationCompletedStages = FontActivationCompensationStages;

export interface FontActivationCompensationResult {
  attempted: boolean;
  errors: string[];
  pending: FontActivationCompensationStages;
  durable: boolean;
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error) return error.message;
  const message = String(error || "").trim();
  return message || fallback;
}

function hasPendingStages(stages: FontActivationCompensationStages): boolean {
  return stages.resource || stages.registry || stages.file;
}

export function fontActivationFailureWithCompensation(
  originalError: unknown,
  result: FontActivationCompensationResult,
): Error {
  const rootMessage = errorMessage(originalError, "字体激活失败。");
  if (!result.attempted) {
    return originalError instanceof Error
      ? originalError
      : new Error(rootMessage);
  }

  let suffix = "逆序补偿已完成。";
  if (hasPendingStages(result.pending)) {
    suffix = `逆序补偿未完成：${result.errors.join("；") || "仍有待清理阶段。"}${
      result.durable
        ? "；未完成阶段已写入持久清理队列。"
        : "；未完成阶段无法写入持久清理队列。"
    }`;
  } else if (result.errors.length) {
    suffix = `逆序补偿已完成，但持久状态维护出现错误：${result.errors.join("；")}。`;
  }

  const combined = new Error(`${rootMessage}；${suffix}`);
  (combined as Error & { cause?: unknown }).cause = originalError;
  return combined;
}

export function createFontActivationCompensationRuntime(
  deps: FontActivationRuntimeDeps,
  cleanupRuntime: FontActivationCleanupRuntime,
) {
  const {
    removeFontResourceSession,
    deleteRegistryValueHKCU,
    appendStartupLog,
  } = deps;
  const { queueTemporaryFontFileDeletes } = cleanupRuntime;
  const compensationQueue = createFontActivationCompensationQueue(deps);

  async function settleCompensation(
    entry: PendingFontActivationCompensation,
    alreadyDurable: boolean,
  ): Promise<FontActivationCompensationResult> {
    const errors: string[] = [];
    let durable = alreadyDurable;

    const persistProgress = async (label: string) => {
      try {
        await compensationQueue.upsert(entry);
        durable = true;
      } catch (error) {
        errors.push(
          `${label}持久化失败：${errorMessage(error, "无法写入补偿队列。")}`,
        );
      }
    };

    if (!alreadyDurable) {
      await persistProgress("补偿登记");
    }

    if (entry.pending.resource) {
      try {
        await removeFontResourceSession(entry.record.installPath, {
          notify: true,
          reason: "activate-rollback",
        });
        entry.pending.resource = false;
        await persistProgress("资源补偿进度");
      } catch (error) {
        errors.push(
          `资源补偿失败：${errorMessage(error, "字体资源移除失败。")}`,
        );
      }
    }

    if (entry.pending.registry) {
      try {
        await deleteRegistryValueHKCU(entry.record.registryName);
        entry.pending.registry = false;
        await persistProgress("注册表补偿进度");
      } catch (error) {
        errors.push(
          `注册表补偿失败：${errorMessage(error, "注册表值删除失败。")}`,
        );
      }
    }

    if (
      entry.pending.file &&
      !entry.pending.resource &&
      !entry.pending.registry
    ) {
      try {
        const queueResult = await queueTemporaryFontFileDeletes(
          [entry.record],
          "activate-rollback",
        );
        const queueEntry = Object.entries(queueResult).find(
          ([filePath]) =>
            filePath.toLowerCase() === entry.record.installPath.toLowerCase(),
        )?.[1];
        if (!queueEntry?.ok) {
          throw new Error(
            queueEntry?.message || "持久文件删除队列缺少目标结果。",
          );
        }
        entry.pending.file = false;
        await persistProgress("文件补偿进度");
      } catch (error) {
        errors.push(
          `文件补偿失败：${errorMessage(error, "文件无法进入持久删除队列。")}`,
        );
      }
    }

    entry.attempts += 1;
    entry.lastError = errors.join("；");
    if (hasPendingStages(entry.pending)) {
      await persistProgress("补偿结果");
    } else {
      try {
        await compensationQueue.remove(entry.record);
        durable = false;
      } catch (error) {
        durable = true;
        errors.push(
          `补偿记录清除失败：${errorMessage(error, "无法清除补偿记录。")}`,
        );
      }
    }

    if (errors.length) {
      appendStartupLog(
        `font activation compensation incomplete: fontId=${entry.record.fontId}, ${errors.join("; ")}`,
      );
    }
    return {
      attempted: true,
      errors,
      pending: { ...entry.pending },
      durable,
    };
  }

  async function compensateFailedFontActivation(
    record: TemporaryActiveFontRecord,
    completed: FontActivationCompletedStages,
  ): Promise<FontActivationCompensationResult> {
    if (!hasPendingStages(completed)) {
      return {
        attempted: false,
        errors: [],
        pending: { file: false, registry: false, resource: false },
        durable: false,
      };
    }
    const entry: PendingFontActivationCompensation = {
      record,
      pending: { ...completed },
      queuedAt: new Date().toISOString(),
      attempts: 0,
      reason: "activate-failed",
      lastError: "",
    };
    return settleCompensation(entry, false);
  }

  async function cleanupPendingFontActivationCompensations(
    reason: "startup" | "quit" | "manual" = "manual",
  ): Promise<{ cleaned: number; remaining: number }> {
    const records = await compensationQueue.load();
    if (!records.length) return { cleaned: 0, remaining: 0 };
    appendStartupLog(
      `pending font activation compensation started: reason=${reason}, count=${records.length}`,
    );
    for (const entry of records) {
      await settleCompensation(entry, true);
    }
    const remaining = (await compensationQueue.load()).length;
    const cleaned = Math.max(0, records.length - remaining);
    appendStartupLog(
      `pending font activation compensation finished: reason=${reason}, cleaned=${cleaned}, remaining=${remaining}`,
    );
    return { cleaned, remaining };
  }

  async function cleanupPendingFontActivationCompensationsUntilEmpty(
    reason: "startup" | "quit" | "manual" = "manual",
    maxAttempts = 18,
  ): Promise<{ cleaned: number; remaining: number }> {
    let totalCleaned = 0;
    let remaining = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const result = await cleanupPendingFontActivationCompensations(reason);
      totalCleaned += result.cleaned;
      remaining = result.remaining;
      if (!remaining) return { cleaned: totalCleaned, remaining: 0 };
      await new Promise((resolveRetry) =>
        setTimeout(resolveRetry, Math.min(1800, 500 + attempt * 120)),
      );
    }
    return { cleaned: totalCleaned, remaining };
  }

  return {
    compensateFailedFontActivation,
    cleanupPendingFontActivationCompensations,
    cleanupPendingFontActivationCompensationsUntilEmpty,
  };
}

export type FontActivationCompensationRuntime = ReturnType<
  typeof createFontActivationCompensationRuntime
>;
