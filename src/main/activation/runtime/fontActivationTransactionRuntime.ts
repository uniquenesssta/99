import fs, { promises as fsp } from "node:fs";
import { basename, join } from "node:path";
import type { FontItem, InstallResult } from "../../../shared/types";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import {
  fontActivationFailureWithCompensation,
  type FontActivationCompensationRuntime,
  type FontActivationCompletedStages,
} from "./fontActivationCompensationRuntime";
import type { FontActivationCopyRuntime } from "./fontActivationCopyRuntime";
import type { FontActivationInstallStatusRuntime } from "./fontActivationInstallStatusRuntime";
import type { FontActivationTraceRuntime } from "./fontActivationTraceRuntime";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";
import type { FontActivationVerifyRuntime } from "./fontActivationVerifyRuntime";

export type FontActivationTransactionOutcome =
  | "activated"
  | "already-active"
  | "already-installed";

export interface FontActivationTransactionResult {
  outcome: FontActivationTransactionOutcome;
  result: InstallResult;
}

export interface FontActivationTransactionPort {
  activateFontSessionTransaction: (
    item: FontItem,
  ) => Promise<FontActivationTransactionResult>;
}

export function createFontActivationTransactionRuntime(
  deps: FontActivationRuntimeDeps,
  traceRuntime: FontActivationTraceRuntime,
  verifyRuntime: FontActivationVerifyRuntime,
  statusRuntime: FontActivationInstallStatusRuntime,
  copyRuntime: FontActivationCopyRuntime,
  compensationRuntime: FontActivationCompensationRuntime,
) {
  const {
    ensureWindows,
    currentUserFontsDir,
    loadTemporaryActiveFonts,
    saveTemporaryActiveFonts,
    safeTemporaryActiveFontName,
    temporaryActiveRegistryNameFor,
    removeFontResourceSession,
    addFontResourceSession,
    writeFontRegistryValuesHKCUBatch,
    deleteRegistryValueHKCU,
  } = deps;
  const { activationTraceStep } = traceRuntime;
  const {
    quickTemporaryActiveRecordMessage,
    quickInstalledActivationMessage,
  } = verifyRuntime;
  const {
    compareActivationInstallStatus,
    saveActivationInstallStatus,
    temporaryActiveRecordToInstalledRecord,
  } = statusRuntime;
  const { copyTemporaryActiveFontWithTrace } = copyRuntime;
  const { compensateFailedFontActivation } = compensationRuntime;
  let activationTail: Promise<void> = Promise.resolve();

  async function runFontActivationTransaction(
    item: FontItem,
  ): Promise<FontActivationTransactionResult> {
    ensureWindows();
    await activationTraceStep("access-source", item.id, () =>
      fsp.access(item.path),
    );

    const state = await activationTraceStep("load-session-state", item.id, () =>
      loadTemporaryActiveFonts(),
    );
    const existing = state.records.find((record) => record.fontId === item.id);

    if (existing && fs.existsSync(existing.installPath)) {
      const desiredRegistryName = temporaryActiveRegistryNameFor(item);
      let refreshedRecord = existing;
      if (desiredRegistryName && desiredRegistryName !== existing.registryName) {
        await activationTraceStep(
          "migrate-existing-registry-name",
          item.id,
          async () => {
            await writeFontRegistryValuesHKCUBatch([
              { name: desiredRegistryName, path: existing.installPath },
            ]);
            await deleteRegistryValueHKCU(existing.registryName);
            refreshedRecord = { ...existing, registryName: desiredRegistryName };
            const migratedRecords = state.records.map((record) =>
              record === existing ? refreshedRecord : record,
            );
            await saveTemporaryActiveFonts({
              version: 1,
              records: migratedRecords,
            });
          },
        );
      }
      await activationTraceStep("remove-existing-resource", item.id, () =>
        removeFontResourceSession(refreshedRecord.installPath),
      );
      await activationTraceStep("add-existing-resource", item.id, () =>
        addFontResourceSession(refreshedRecord.installPath, {
          notify: true,
          reason: "reactivate-existing-temporary",
        }),
      );
      const message = quickTemporaryActiveRecordMessage(refreshedRecord);
      return {
        outcome: "already-active",
        result: {
          ok: true,
          managedInstallPath: refreshedRecord.installPath,
          managedRegistryName: refreshedRecord.registryName,
          temporaryActivated: true,
          message: `字体已处于激活状态，已重新发送系统字体强刷新。${message} 如果 Photoshop 仍未出现，请切回 Photoshop 或重开字体菜单。`,
        },
      };
    }

    const compare = await activationTraceStep(
      "read-install-status-cache",
      item.id,
      () => compareActivationInstallStatus(item),
    );

    if (compare.installed) {
      const message = quickInstalledActivationMessage(item);
      return {
        outcome: "already-installed",
        result: {
          ok: true,
          temporaryActivated: false,
          message: `字体已经是已安装状态，未重复临时激活；已重新通知系统字体变化。${message} 如果 Photoshop 仍未出现，请切回 Photoshop 或重开字体菜单。`,
        },
      };
    }

    const fontsDir = currentUserFontsDir();
    await fsp.mkdir(fontsDir, { recursive: true });
    const copyName = safeTemporaryActiveFontName(item);
    const dest = join(fontsDir, copyName);
    const regName = temporaryActiveRegistryNameFor(item);
    const record: TemporaryActiveFontRecord = {
      fontId: item.id,
      sourcePath: item.path,
      installPath: dest,
      registryName: regName,
      activatedAt: new Date().toISOString(),
      fileName: basename(dest),
    };
    const completed: FontActivationCompletedStages = {
      file: false,
      registry: false,
      resource: false,
    };
    let copyMode: Awaited<
      ReturnType<typeof copyTemporaryActiveFontWithTrace>
    > = "copied";
    try {
      copyMode = await activationTraceStep("copy-to-user-fonts", item.id, () =>
        copyTemporaryActiveFontWithTrace(item, dest),
      );
      completed.file = copyMode !== "skipped-same-path";

      await activationTraceStep("write-hkcu-registry", item.id, () =>
        writeFontRegistryValuesHKCUBatch([{ name: regName, path: dest }]),
      );
      completed.registry = true;

      await activationTraceStep("add-font-resource", item.id, () =>
        addFontResourceSession(dest, { notify: true, reason: "activate" }),
      );
      completed.resource = true;

      const nextRecords = state.records.filter(
        (old) => old.fontId !== item.id,
      );
      nextRecords.push(record);
      await activationTraceStep("save-session-state", item.id, () =>
        saveTemporaryActiveFonts({ version: 1, records: nextRecords }),
      );
    } catch (error) {
      const compensation = await compensateFailedFontActivation(
        record,
        completed,
      );
      throw fontActivationFailureWithCompensation(error, compensation);
    }
    await saveActivationInstallStatus(item, {
      installed: true,
      by: "managed",
      matches: [temporaryActiveRecordToInstalledRecord(record)],
    });

    const message = quickTemporaryActiveRecordMessage(record);
    return {
      outcome: "activated",
      result: {
        ok: true,
        managedInstallPath: dest,
        managedRegistryName: regName,
        temporaryActivated: true,
        message: `已激活字体。底层为临时安装到当前用户字体目录，复制状态：${copyMode}。退出软件时会自动清理。${message} 如果 Photoshop 已打开但未立即出现，请切回 Photoshop 或重开字体菜单。`,
      },
    };
  }

  function activateFontSessionTransaction(
    item: FontItem,
  ): Promise<FontActivationTransactionResult> {
    const task = activationTail.then(() => runFontActivationTransaction(item));
    activationTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  return { activateFontSessionTransaction };
}

export type FontActivationTransactionRuntime = ReturnType<
  typeof createFontActivationTransactionRuntime
>;
