import { assertApplicationOpen, applicationWorkEpoch } from '../../app/shutdownCoordinatorRuntime';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { createManagedActivationIdentityRuntime, sameManagedIdentity } from './managedActivationIdentityRuntime';
import { promises as fsp } from "node:fs";
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
  const identityRuntime = createManagedActivationIdentityRuntime(deps);
  let activationTail: Promise<void> = Promise.resolve();

  async function runFontActivationTransaction(
    item: FontItem,
  ): Promise<FontActivationTransactionResult> {
    const workEpoch = applicationWorkEpoch();
    assertApplicationOpen(workEpoch);
    ensureWindows();
    const state = await activationTraceStep("load-session-state", item.id, () =>
      loadTemporaryActiveFonts(),
    );
    const existing = state.records.find((record) => record.fontId === item.id);

    if (existing) {
      if (existing.stage && existing.stage !== 'active') throw new Error('此字体有未完成的清理记录，请先处理残留。');
      if (!await identityRuntime.verify(existing)) throw new Error('本机激活副本缺失，请先处理残留记录。');
      deps.requestFontRefresh('already-active', 'standard');
      return { outcome: 'already-active', result: { ok: true, managedInstallPath: existing.installPath,
        managedRegistryName: existing.registryName, temporaryActivated: true, message: '字体已经激活，本机副本身份已确认。' } };
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
    const sessionId = randomUUID();
    const baseName = safeTemporaryActiveFontName(item);
    const extension = extname(baseName);
    const copyName = `${baseName.slice(0, baseName.length - extension.length)}_${sessionId}${extension}`;
    const dest = join(fontsDir, copyName);
    const regName = `${temporaryActiveRegistryNameFor(item)} [${sessionId}]`;
    const record: TemporaryActiveFontRecord = {
      sessionId,
      stage: "copy-pending",
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
    let copyMode = "copied";
    assertApplicationOpen(workEpoch);
    await compensationRuntime.recordActivationIntent(record, { file: true, registry: false, resource: false });
    completed.file = true;
    try {
      const copy = await activationTraceStep("copy-to-user-fonts", item.id, () =>
        copyTemporaryActiveFontWithTrace(item, dest),
      );
      const identity = await identityRuntime.inspect(dest);
      if (!identity || !sameManagedIdentity(identity, copy.identity)) throw new Error('复制回执之后本机副本缺失或已替换，禁止激活。');
      copyMode = copy.mode;
      record.identity = copy.identity;
      await compensationRuntime.recordActivationIntent(record, completed);
      await compensationRuntime.queueCopyPartial(record);
      assertApplicationOpen(workEpoch);
      record.stage = 'registry-pending';
      completed.registry = true;
      await compensationRuntime.recordActivationIntent(record, completed);

      await activationTraceStep("write-hkcu-registry", item.id, () => {
        assertApplicationOpen(workEpoch);
        return writeFontRegistryValuesHKCUBatch([{ name: regName, path: dest }]);
      },
      );
      completed.registry = true;

      record.stage = 'resource-pending';
      completed.resource = true;
      await compensationRuntime.recordActivationIntent(record, completed);
      await activationTraceStep("add-font-resource", item.id, () => {
        assertApplicationOpen(workEpoch);
        return addFontResourceSession(dest, { notify: true, reason: "activate" });
      },
      );
      completed.resource = true;

      assertApplicationOpen(workEpoch);
      record.stage = 'active';
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
    await compensationRuntime.completeActivationIntent(record);
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
    const ticket = applicationWorkEpoch();
    const task = activationTail.then(() => { assertApplicationOpen(ticket); return runFontActivationTransaction(item); });
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
