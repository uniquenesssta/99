import type { FontItem, InstallResult } from "../../../shared/types";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontActivationCleanupRuntime } from "./fontActivationCleanupRuntime";
import type { FontActivationInstallStatusRuntime } from "./fontActivationInstallStatusRuntime";
import type { FontActivationTransactionPort } from "./fontActivationTransactionRuntime";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";

export function createFontActivationSessionRuntime(
  deps: FontActivationRuntimeDeps,
  statusRuntime: FontActivationInstallStatusRuntime,
  cleanupRuntime: FontActivationCleanupRuntime,
  transactionRuntime: FontActivationTransactionPort,
) {
  const {
    ensureWindows,
    loadTemporaryActiveFonts,
    saveTemporaryActiveFonts,
    requestFontRefresh,
    scheduleBackgroundFontRefreshTail,
  } = deps;
  const { saveActivationInstallStatus } = statusRuntime;
  const { removeTemporaryActiveRecord } = cleanupRuntime;
  const { activateFontSessionTransaction } = transactionRuntime;

  async function activateFontSession(item: FontItem): Promise<InstallResult> {
    const transaction = await activateFontSessionTransaction(item);
    requestFontRefresh(
      transaction.outcome === "already-installed"
        ? "activate-existing-installed"
        : transaction.outcome === "already-active"
          ? "reactivate-existing-temporary-photoshop-tail"
          : "activate-photoshop-tail",
      "strong",
      {
        delayMs: transaction.outcome === "already-installed" ? 250 : 900,
        force: true,
      },
    );
    return transaction.result;
  }

  async function deactivateFontSession(item: FontItem): Promise<InstallResult> {
    ensureWindows();

    const state = await loadTemporaryActiveFonts();
    const targets = state.records.filter(
      (record) =>
        record.fontId === item.id ||
        record.sourcePath.toLowerCase() === item.path.toLowerCase(),
    );

    if (!targets.length) {
      return {
        ok: true,
        message:
          "没有找到这个字体的临时安装记录；如果它是永久安装字体，不会被移除。",
      };
    }

    const remaining: TemporaryActiveFontRecord[] = [];
    let cleaned = 0;

    for (const record of state.records) {
      if (!targets.includes(record)) {
        remaining.push(record);
        continue;
      }

      const ok = await removeTemporaryActiveRecord(record, {
        verifyVisibility: false,
        deleteFileMode: "background",
      });
      if (ok) {
        cleaned += 1;
      } else {
        remaining.push(record);
      }
    }

    await saveTemporaryActiveFonts({ version: 1, records: remaining });
    if (cleaned > 0) {
      await saveActivationInstallStatus(item, {
        installed: false,
        by: "none",
        matches: [],
      });
    }
    scheduleBackgroundFontRefreshTail("deactivate-tail", 80);

    return {
      ok: true,
      message:
        cleaned === targets.length
          ? "已取消激活；临时字体文件已转入后台清理。"
          : `已取消激活 ${cleaned} 项；仍有 ${targets.length - cleaned} 项可能被占用，将在下次启动继续清理。`,
    };
  }

  return { activateFontSession, deactivateFontSession };
}

export type FontActivationSessionRuntime = ReturnType<
  typeof createFontActivationSessionRuntime
>;
