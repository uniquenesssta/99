import fs,{ promises as fsp } from "node:fs";
import { basename,join } from "node:path";
import type { FontActivationBatchResult,FontItem,InstallCompareResult } from "../../../shared/types";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontActivationCleanupRuntime } from "./fontActivationCleanupRuntime";
import type { FontActivationCopyRuntime } from "./fontActivationCopyRuntime";
import type { FontActivationInstallStatusRuntime } from "./fontActivationInstallStatusRuntime";
import { uniqueFontItems } from "./fontActivationInstallStatusRuntime";
import type { FontActivationTraceRuntime } from "./fontActivationTraceRuntime";
import { createFontDeactivationBatchRuntime } from "./fontDeactivationBatchRuntime";
import type { FontActivationRuntimeDeps,PreparedTemporaryActivation } from "./fontActivationTypes";

export function createFontActivationBatchRuntime(
  deps: FontActivationRuntimeDeps,
  traceRuntime: FontActivationTraceRuntime,
  statusRuntime: FontActivationInstallStatusRuntime,
  cleanupRuntime: FontActivationCleanupRuntime,
  copyRuntime: FontActivationCopyRuntime,
) {
  const {
    ensureWindows,
    currentUserFontsDir,
    loadTemporaryActiveFonts,
    saveTemporaryActiveFonts,
    safeTemporaryActiveFontName,
    temporaryActiveRegistryNameFor,
    removeFontResourceSessionBatch,
    addFontResourceSessionBatch,
    writeFontRegistryValuesHKCUBatch,
    deleteFontRegistryValuesHKCUBatch,
    scheduleActivationInstallStatusSave,
    requestFontRefresh,
    withGlobalIo,
    appendStartupLog,
  } = deps;
  const { activationTraceStep } = traceRuntime;
  const {
    readActivationInstallStatusBatch,
    temporaryActiveRecordToInstalledRecord,
  } = statusRuntime;
  const { copyTemporaryActiveFontWithTrace } = copyRuntime;

  async function activateFontSessionsBatch(
    items: FontItem[],
  ): Promise<FontActivationBatchResult> {
    const batchStartedAt = Date.now();
    ensureWindows();
    const unique = uniqueFontItems(items).slice(0, 1000);
    const results: FontActivationBatchResult["results"] = {};
    const state = await activationTraceStep(
      "batch-load-session-state",
      "batch",
      () => loadTemporaryActiveFonts(),
    );
    const nextRecords = state.records.slice();
    const prepared: PreparedTemporaryActivation[] = [];
    const registryRecords: Array<{ name: string; path: string }> = [];
    const installStatusById = await activationTraceStep(
      "batch-read-install-status-cache",
      "batch",
      () => readActivationInstallStatusBatch(unique),
    );
    const fontsDir = currentUserFontsDir();
    await activationTraceStep("batch-ensure-user-fonts-dir", "batch", () =>
      fsp.mkdir(fontsDir, { recursive: true }),
    );

    let activated = 0;
    let skippedInstalled = 0;
    let skippedAlreadyActive = 0;
    let failed = 0;

    for (const item of unique) {
      try {
        await activationTraceStep("batch-access-source", item.id, () =>
          withGlobalIo("activate:access-font", () => fsp.access(item.path), {
            priority: "foreground",
            storagePath: item.path,
          }),
        );

        const existing = state.records.find(
          (record) => record.fontId === item.id,
        );
        if (existing && fs.existsSync(existing.installPath)) {
          skippedAlreadyActive += 1;
          prepared.push({ item, record: existing, created: false });
          results[item.id] = {
            id: item.id,
            fileName: item.fileName,
            ok: true,
            managedInstallPath: existing.installPath,
            managedRegistryName: existing.registryName,
            temporaryActivated: true,
            message: "字体已处于激活状态，已加入本轮系统刷新。",
          };
          continue;
        }

        const compare = installStatusById[item.id] || {
          installed: false,
          by: "none",
          matches: [],
        };
        if (compare.installed) {
          skippedInstalled += 1;
          results[item.id] = {
            id: item.id,
            fileName: item.fileName,
            ok: true,
            temporaryActivated: false,
            message: "字体已经是已安装状态，未重复临时激活。",
          };
          continue;
        }

        const copyName = safeTemporaryActiveFontName(item);
        const dest = join(fontsDir, copyName);
        const copyMode = await activationTraceStep(
          "batch-copy-to-user-fonts",
          item.id,
          () => copyTemporaryActiveFontWithTrace(item, dest, "batch"),
        );
        appendStartupLog(
          `activation batch copy result: fontId=${item.id}, mode=${copyMode}`,
        );
        const regName = temporaryActiveRegistryNameFor(item);
        const record: TemporaryActiveFontRecord = {
          fontId: item.id,
          sourcePath: item.path,
          installPath: dest,
          registryName: regName,
          activatedAt: new Date().toISOString(),
          fileName: basename(dest),
        };
        prepared.push({ item, record, created: true });
        registryRecords.push({ name: regName, path: dest });
      } catch (error) {
        failed += 1;
        results[item.id] = {
          id: item.id,
          fileName: item.fileName,
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }

    try {
      await activationTraceStep("batch-write-hkcu-registry", "batch", () =>
        writeFontRegistryValuesHKCUBatch(registryRecords),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const preparedItem of prepared.filter((entry) => entry.created)) {
        if (results[preparedItem.item.id]?.ok === false) continue;
        failed += 1;
        results[preparedItem.item.id] = {
          id: preparedItem.item.id,
          fileName: preparedItem.item.fileName,
          ok: false,
          message: `HKCU 字体注册表批量写入失败：${message}`,
        };
        await fsp
          .rm(preparedItem.record.installPath, { force: true })
          .catch(() => undefined);
      }
    }

    const stillPrepared = prepared.filter(
      (entry) => results[entry.item.id]?.ok !== false,
    );
    const existingPaths = stillPrepared
      .filter((entry) => !entry.created)
      .map((entry) => entry.record.installPath);
    if (existingPaths.length)
      await removeFontResourceSessionBatch(existingPaths).catch((error) =>
        appendStartupLog(
          `batch remove before add skipped: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );

    const addResults = await activationTraceStep(
      "batch-add-font-resource",
      "batch",
      () =>
        addFontResourceSessionBatch(
          stillPrepared.map((entry) => entry.record.installPath),
          { notify: true, reason: "batch-activate" },
        ),
    );
    let changed = false;
    for (const entry of stillPrepared) {
      const addResult = addResults[entry.record.installPath];
      if (!addResult?.ok) {
        failed += 1;
        if (entry.created) {
          await deleteFontRegistryValuesHKCUBatch([
            entry.record.registryName,
          ]).catch(() => undefined);
          await fsp
            .rm(entry.record.installPath, { force: true })
            .catch(() => undefined);
        }
        results[entry.item.id] = {
          id: entry.item.id,
          fileName: entry.item.fileName,
          ok: false,
          message: addResult?.message || "AddFontResourceEx 批量激活失败。",
        };
        continue;
      }

      if (entry.created) {
        activated += 1;
        const existingIndex = nextRecords.findIndex(
          (record) => record.fontId === entry.record.fontId,
        );
        if (existingIndex >= 0) nextRecords.splice(existingIndex, 1);
        nextRecords.push(entry.record);
        changed = true;
      }

      results[entry.item.id] = {
        id: entry.item.id,
        fileName: entry.item.fileName,
        ok: true,
        managedInstallPath: entry.record.installPath,
        managedRegistryName: entry.record.registryName,
        temporaryActivated: true,
        message: entry.created
          ? "已临时激活。"
          : "字体已处于激活状态，已重新加入系统字体资源。",
      };
    }

    if (changed)
      await activationTraceStep("batch-save-session-state", "batch", () =>
        saveTemporaryActiveFonts({ version: 1, records: nextRecords }),
      );
    const activatedStatusUpdates: Record<string, InstallCompareResult> = {};
    const activatedItemsById = new Map<string, FontItem>();
    for (const entry of stillPrepared) {
      if (!results[entry.item.id]?.ok) continue;
      activatedStatusUpdates[entry.item.id] = {
        installed: true,
        by: "managed",
        matches: [temporaryActiveRecordToInstalledRecord(entry.record)],
      };
      activatedItemsById.set(entry.item.id, entry.item);
    }
    if (Object.keys(activatedStatusUpdates).length) {
      scheduleActivationInstallStatusSave(
        activatedStatusUpdates,
        activatedItemsById,
        "batch-activate",
      );
    }
    if (activated > 0 || skippedAlreadyActive > 0 || skippedInstalled > 0) {
      requestFontRefresh("batch-activate-photoshop-tail", "strong", {
        delayMs: 900,
        force: true,
      });
    }

    appendStartupLog(
      `activation batch summary: total=${unique.length}, activated=${activated}, skippedInstalled=${skippedInstalled}, skippedAlreadyActive=${skippedAlreadyActive}, failed=${failed}, elapsed=${Date.now() - batchStartedAt}ms`,
    );
    const ok = failed === 0;
    return {
      ok,
      activated,
      skippedInstalled,
      skippedAlreadyActive,
      failed,
      results,
      message: `批量激活完成：临时激活 ${activated} 个，已激活刷新 ${skippedAlreadyActive} 个，跳过已安装 ${skippedInstalled} 个，失败 ${failed} 个。`,
    };
  }

  const { deactivateFontSessionsBatch } = createFontDeactivationBatchRuntime(deps, cleanupRuntime);

  return { activateFontSessionsBatch, deactivateFontSessionsBatch };
}

export type FontActivationBatchRuntime = ReturnType<typeof createFontActivationBatchRuntime>;
