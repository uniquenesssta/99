import fs,{ promises as fsp } from "node:fs";
import { basename,join } from "node:path";
import type { FontItem,InstallResult } from "../../../shared/types";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontActivationCleanupRuntime } from "./fontActivationCleanupRuntime";
import type { FontActivationCopyRuntime } from "./fontActivationCopyRuntime";
import type { FontActivationInstallStatusRuntime } from "./fontActivationInstallStatusRuntime";
import type { FontActivationTraceRuntime } from "./fontActivationTraceRuntime";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";
import type { FontActivationVerifyRuntime } from "./fontActivationVerifyRuntime";

export function createFontActivationSessionRuntime(
  deps: FontActivationRuntimeDeps,
  traceRuntime: FontActivationTraceRuntime,
  verifyRuntime: FontActivationVerifyRuntime,
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
    removeFontResourceSession,
    addFontResourceSession,
    writeFontRegistryValuesHKCUBatch,
    deleteRegistryValueHKCU,
    requestFontRefresh,
    scheduleBackgroundFontRefreshTail,
  } = deps;
  const { activationTraceStep } = traceRuntime;
  const { quickTemporaryActiveRecordMessage, quickInstalledActivationMessage } = verifyRuntime;
  const {
    compareActivationInstallStatus,
    saveActivationInstallStatus,
    temporaryActiveRecordToInstalledRecord,
  } = statusRuntime;
  const { removeTemporaryActiveRecord } = cleanupRuntime;
  const { copyTemporaryActiveFontWithTrace } = copyRuntime;

  async function activateFontSession(item: FontItem): Promise<InstallResult> {
    // v0.8.7：界面文案仍叫“激活”，但底层改为“临时安装”。
    // 临时安装范围：当前用户字体目录 + HKCU Fonts 注册表。
    // 退出软件时会自动清理本次临时安装的字体；异常退出残留会在下次启动清理。
    ensureWindows();
    await activationTraceStep("access-source", item.id, () =>
      fsp.access(item.path),
    );

    const state = await activationTraceStep("load-session-state", item.id, () =>
      loadTemporaryActiveFonts(),
    );
    const existing = state.records.find((record) => record.fontId === item.id);

    if (existing && fs.existsSync(existing.installPath)) {
      // 已激活时也重新刷新一遍：Photoshop 偶尔会漏掉第一次 WM_FONTCHANGE。
      // 先 Remove 再 Add，避免重复 AddFontResourceEx 造成引用计数残留。
      const desiredRegistryName = temporaryActiveRegistryNameFor(item);
      let refreshedRecord = existing;
      if (desiredRegistryName && desiredRegistryName !== existing.registryName) {
        await activationTraceStep("migrate-existing-registry-name", item.id, async () => {
          await writeFontRegistryValuesHKCUBatch([
            { name: desiredRegistryName, path: existing.installPath },
          ]);
          await deleteRegistryValueHKCU(existing.registryName);
          refreshedRecord = { ...existing, registryName: desiredRegistryName };
          const migratedRecords = state.records.map((record) =>
            record === existing ? refreshedRecord : record,
          );
          await saveTemporaryActiveFonts({ version: 1, records: migratedRecords });
        });
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
      requestFontRefresh("reactivate-existing-temporary-photoshop-tail", "strong", {
        delayMs: 900,
        force: true,
      });
      const message = quickTemporaryActiveRecordMessage(refreshedRecord);

      return {
        ok: true,
        managedInstallPath: refreshedRecord.installPath,
        managedRegistryName: refreshedRecord.registryName,
        temporaryActivated: true,
        message: `字体已处于激活状态，已重新发送系统字体强刷新。${message} 如果 Photoshop 仍未出现，请切回 Photoshop 或重开字体菜单。`,
      };
    }

    const compare = await activationTraceStep(
      "read-install-status-cache",
      item.id,
      () => compareActivationInstallStatus(item),
    );

    if (compare.installed) {
      requestFontRefresh("activate-existing-installed", "strong", {
        delayMs: 250,
        force: true,
      });

      const message = quickInstalledActivationMessage(item);
      return {
        ok: true,
        temporaryActivated: false,
        message: `字体已经是已安装状态，未重复临时激活；已重新通知系统字体变化。${message} 如果 Photoshop 仍未出现，请切回 Photoshop 或重开字体菜单。`,
      };
    }

    const fontsDir = currentUserFontsDir();
    await fsp.mkdir(fontsDir, { recursive: true });

    const copyName = safeTemporaryActiveFontName(item);
    const dest = join(fontsDir, copyName);
    const copyMode = await activationTraceStep(
      "copy-to-user-fonts",
      item.id,
      () => copyTemporaryActiveFontWithTrace(item, dest),
    );

    const regName = temporaryActiveRegistryNameFor(item);
    await activationTraceStep("write-hkcu-registry", item.id, () =>
      writeFontRegistryValuesHKCUBatch([{ name: regName, path: dest }]),
    );

    await activationTraceStep("add-font-resource", item.id, () =>
      addFontResourceSession(dest, { notify: true, reason: "activate" }),
    );
    requestFontRefresh("activate-photoshop-tail", "strong", {
      delayMs: 900,
      force: true,
    });

    const record: TemporaryActiveFontRecord = {
      fontId: item.id,
      sourcePath: item.path,
      installPath: dest,
      registryName: regName,
      activatedAt: new Date().toISOString(),
      fileName: basename(dest),
    };

    const nextRecords = state.records.filter((old) => old.fontId !== item.id);
    nextRecords.push(record);
    await activationTraceStep("save-session-state", item.id, () =>
      saveTemporaryActiveFonts({ version: 1, records: nextRecords }),
    );
    await saveActivationInstallStatus(item, {
      installed: true,
      by: "managed",
      matches: [temporaryActiveRecordToInstalledRecord(record)],
    });

    const message = quickTemporaryActiveRecordMessage(record);
    return {
      ok: true,
      managedInstallPath: dest,
      managedRegistryName: regName,
      temporaryActivated: true,
      message: `已激活字体。底层为临时安装到当前用户字体目录，复制状态：${copyMode}。退出软件时会自动清理。${message} 如果 Photoshop 已打开但未立即出现，请切回 Photoshop 或重开字体菜单。`,
    };
  }

  async function deactivateFontSession(item: FontItem): Promise<InstallResult> {
    // v0.8.7：取消激活 = 移除本工具本次创建的临时安装记录。
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

export type FontActivationSessionRuntime = ReturnType<typeof createFontActivationSessionRuntime>;
