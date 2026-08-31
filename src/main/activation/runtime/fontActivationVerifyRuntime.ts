import fs from "node:fs";
import { resolve } from "node:path";
import type { FontItem,SystemInstalledFont } from "../../../shared/types";
import type { TemporaryActiveFontRecord } from "../../windows/fontRuntime";
import type { FontActivationRuntimeDeps } from "./fontActivationTypes";

export function createFontActivationVerifyRuntime(deps: FontActivationRuntimeDeps) {
  const {
    normalizePathForCacheCompare,
    compareFontInstalledWithList,
    clearInstalledFontsMemoryCache,
    getSystemInstalledFontsCached,
    appendStartupLog,
  } = deps;

  function installedFontRecordMatchesPath(
    record: SystemInstalledFont,
    filePath: string,
  ): boolean {
    const target = normalizePathForCacheCompare(resolve(filePath));
    const candidates = [record.path, record.value]
      .filter((value): value is string => !!value)
      .map((value) => normalizePathForCacheCompare(resolve(value)));
    return candidates.some((value) => value === target);
  }

  function activationVerifyMessage(ok: boolean, detail: string): string {
    if (ok) return `Windows 字体记录验证通过；${detail}`;
    return `已完成系统广播，但 Windows 字体记录验证未完全通过：${detail}`;
  }

  function quickActivationMessage(detail: string): string {
    return `已完成快速激活处理；${detail}`;
  }

  function quickTemporaryActiveRecordMessage(
    record: TemporaryActiveFontRecord,
  ): string {
    const fileExists = fs.existsSync(record.installPath);
    const detail = `临时字体文件${fileExists ? "存在" : "暂未确认"}，已写入 HKCU 字体记录并发送 Windows 字体变化通知。`;
    appendStartupLog(
      `temporary activation quick check: fontId=${record.fontId}, fileExists=${fileExists}`,
    );
    return quickActivationMessage(detail);
  }

  function quickInstalledActivationMessage(item: FontItem): string {
    appendStartupLog(`installed activation quick refresh: fontId=${item.id}`);
    return quickActivationMessage(
      "字体已是安装状态，已重新发送 Windows 字体变化通知。",
    );
  }

  async function verifyTemporaryActiveRecord(
    record: TemporaryActiveFontRecord,
  ): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== "win32")
      return { ok: true, message: "非 Windows 环境跳过字体激活验证。" };

    const fileExists = fs.existsSync(record.installPath);
    clearInstalledFontsMemoryCache();
    const installed = await getSystemInstalledFontsCached(true);
    const registryVisible = installed.some(
      (item) =>
        item.source === "HKCU" &&
        item.registryName.toLowerCase() === record.registryName.toLowerCase(),
    );
    const fileVisible = installed.some((item) =>
      installedFontRecordMatchesPath(item, record.installPath),
    );
    const ok = fileExists && registryVisible && fileVisible;
    const detail = `文件${fileExists ? "存在" : "不存在"}，HKCU 注册表${registryVisible ? "可见" : "不可见"}，字体目录索引${fileVisible ? "可见" : "不可见"}。`;
    appendStartupLog(
      `temporary activation verify: fontId=${record.fontId}, ok=${ok}, ${detail}`,
    );
    return { ok, message: activationVerifyMessage(ok, detail) };
  }

  async function temporaryActiveRecordStillVisible(
    record: TemporaryActiveFontRecord,
  ): Promise<boolean> {
    if (process.platform !== "win32") return false;

    const fileExists = fs.existsSync(record.installPath);
    clearInstalledFontsMemoryCache();
    const installed = await getSystemInstalledFontsCached(true);
    const registryVisible = installed.some(
      (item) =>
        item.source === "HKCU" &&
        item.registryName.toLowerCase() === record.registryName.toLowerCase(),
    );
    const fileVisible = installed.some((item) =>
      installedFontRecordMatchesPath(item, record.installPath),
    );

    return fileExists || registryVisible || fileVisible;
  }

  async function verifyInstalledFontVisibility(
    item: FontItem,
  ): Promise<{ ok: boolean; message: string }> {
    if (process.platform !== "win32")
      return { ok: true, message: "非 Windows 环境跳过字体激活验证。" };

    clearInstalledFontsMemoryCache();
    const installed = await getSystemInstalledFontsCached(true);
    const compare = compareFontInstalledWithList(item, installed);
    const pathVisible = installed.some((record) =>
      installedFontRecordMatchesPath(record, item.path),
    );
    const ok = compare.installed || pathVisible;
    const detail = `安装记录${compare.installed ? "可见" : "未匹配"}，路径索引${pathVisible ? "可见" : "未匹配"}。`;
    appendStartupLog(
      `installed activation verify: fontId=${item.id}, ok=${ok}, ${detail}`,
    );
    return { ok, message: activationVerifyMessage(ok, detail) };
  }

  return {
    installedFontRecordMatchesPath,
    activationVerifyMessage,
    quickActivationMessage,
    quickTemporaryActiveRecordMessage,
    quickInstalledActivationMessage,
    verifyTemporaryActiveRecord,
    temporaryActiveRecordStillVisible,
    verifyInstalledFontVisibility,
  };
}

export type FontActivationVerifyRuntime = ReturnType<typeof createFontActivationVerifyRuntime>;
