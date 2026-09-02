import type {
  FontActivationBatchResult,
  FontItem,
} from "../../../shared/types";
import type { FontActivationCleanupRuntime } from "./fontActivationCleanupRuntime";
import { uniqueFontItems } from "./fontActivationInstallStatusRuntime";
import type { FontActivationTransactionPort } from "./fontActivationTransactionRuntime";
import { createFontDeactivationBatchRuntime } from "./fontDeactivationBatchRuntime";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";

export interface FontActivationBatchOptions {
  signal?: AbortSignal;
}

function cancellationMessage(signal: AbortSignal): string {
  const reason = signal.reason;
  const detail =
    reason instanceof Error
      ? reason.message
      : typeof reason === "string"
        ? reason.trim()
        : "";
  return detail
    ? `批量激活已取消，未开始处理：${detail}`
    : "批量激活已取消，未开始处理。";
}

export function createFontActivationBatchRuntime(
  deps: FontActivationRuntimeDeps,
  cleanupRuntime: FontActivationCleanupRuntime,
  transactionRuntime: FontActivationTransactionPort,
) {
  const { ensureWindows, requestFontRefresh, appendStartupLog } = deps;
  const { activateFontSessionTransaction } = transactionRuntime;

  async function activateFontSessionsBatch(
    items: FontItem[],
    options: FontActivationBatchOptions = {},
  ): Promise<FontActivationBatchResult> {
    const batchStartedAt = Date.now();
    ensureWindows();
    const unique = uniqueFontItems(items).slice(0, 1000);
    const results: FontActivationBatchResult["results"] = {};
    let activated = 0;
    let skippedInstalled = 0;
    let skippedAlreadyActive = 0;
    let failed = 0;
    let cancelled = 0;

    for (let index = 0; index < unique.length; index += 1) {
      const item = unique[index];
      if (options.signal?.aborted) {
        const message = cancellationMessage(options.signal);
        for (const unstarted of unique.slice(index)) {
          cancelled += 1;
          results[unstarted.id] = {
            id: unstarted.id,
            fileName: unstarted.fileName,
            ok: false,
            status: "cancelled",
            retryable: true,
            message,
          };
        }
        break;
      }

      try {
        const transaction = await activateFontSessionTransaction(item);
        if (transaction.outcome === "activated") activated += 1;
        else if (transaction.outcome === "already-installed") {
          skippedInstalled += 1;
        } else {
          skippedAlreadyActive += 1;
        }
        results[item.id] = {
          id: item.id,
          fileName: item.fileName,
          status: transaction.outcome,
          ...transaction.result,
        };
      } catch (error) {
        failed += 1;
        results[item.id] = {
          id: item.id,
          fileName: item.fileName,
          ok: false,
          status: "failed",
          retryable: true,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (activated > 0 || skippedAlreadyActive > 0 || skippedInstalled > 0) {
      requestFontRefresh("batch-activate-photoshop-tail", "strong", {
        delayMs: 900,
        force: true,
      });
    }

    appendStartupLog(
      `activation batch summary: total=${unique.length}, activated=${activated}, skippedInstalled=${skippedInstalled}, skippedAlreadyActive=${skippedAlreadyActive}, failed=${failed}, cancelled=${cancelled}, elapsed=${Date.now() - batchStartedAt}ms`,
    );
    return {
      ok: failed === 0 && cancelled === 0,
      activated,
      skippedInstalled,
      skippedAlreadyActive,
      failed,
      cancelled,
      results,
      message: `批量激活完成：临时激活 ${activated} 个，已激活刷新 ${skippedAlreadyActive} 个，跳过已安装 ${skippedInstalled} 个，失败 ${failed} 个，取消 ${cancelled} 个。`,
    };
  }

  const { deactivateFontSessionsBatch } = createFontDeactivationBatchRuntime(
    deps,
    cleanupRuntime,
  );

  return { activateFontSessionsBatch, deactivateFontSessionsBatch };
}

export type FontActivationBatchRuntime = ReturnType<
  typeof createFontActivationBatchRuntime
>;
