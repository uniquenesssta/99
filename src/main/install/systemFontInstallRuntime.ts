import { createFontUninstallRecoveryRuntime } from './fontUninstallRecoveryRuntime';
import type { FontUninstallReceiptStore } from './fontUninstallReceiptRuntime';
import { fontPhysicalKey } from '../fonts/fontContentIdentityRuntime';
import { planFontUninstall, readFontMutationIdentity } from "./fontUninstallPlanRuntime";
import { createFontMutationSession, type FontMutationSession } from "./fontMutationProcessRuntime";
import { fontFileNameToken } from '../fonts/fontFileIdentity'
import fs from 'node:fs';
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime';
import { basename,extname,join,resolve } from "node:path";
import type { FontDeleteResult,FontItem,InstallCompareResult,InstallResult,SystemInstalledFont } from "../../shared/types";
import { deleteFontFilesToTrashRuntime } from "./fontTrashDeleteRuntime";
import { installOverwriteTarget } from "./systemFontInstallHelpersRuntime";
import { readInstallSourceIdentity, type ReadHistoricalFont, type InstallSourceIdentity } from './fontInstallEvidenceRuntime';

export interface SystemFontInstallRuntimeDeps {
  openUninstallReceipts: () => Promise<FontUninstallReceiptStore>;
  readHistoricalFont?: ReadHistoricalFont;
  appName?: string;
  persistUninstallResult: (item: FontItem) => Promise<InstallCompareResult | void>;
  deactivateForFileDelete: (items: FontItem[]) => Promise<{ ok: boolean; message: string }>;
  createMutationSession?: () => Promise<FontMutationSession>;
  readUninstallRegistry?: () => Promise<SystemInstalledFont[]>;
  withFontProtection: <T>(items: FontItem[], action: (check: () => Promise<void>) => Promise<T>) => Promise<T>;
  fontExtensions: Set<string>;
  ensureWindows: () => void;
  currentUserFontsDir: () => string;
  windowsFontsDir: () => string;
  registryNameFor: (item: FontItem) => string;
  normalizePathForCacheCompare: (path: string) => string;
  normalizeCompareText: (text: string) => string;
  isTemporaryActiveInstalledRecord: (record: SystemInstalledFont) => boolean;
  isPathInsideAnyRoot: (filePath: string, roots: string[]) => boolean;
  getSystemInstalledFonts: () => Promise<SystemInstalledFont[]>;
  getSystemInstalledFontsCached: (forceRefresh?: boolean) => Promise<SystemInstalledFont[]>;
  clearInstalledFontsMemoryCache: () => void;
  writeFontRegistryValuesHKCUBatch: (items: Array<{ name: string; path: string }>) => Promise<void>;
  deleteFontRegistryValuesHKCUBatch: (names: string[]) => Promise<void>;
  advancedFontRefresh: (reason: string) => Promise<void>;
  activationTraceStep: <T>(label: string, fontId: string, fn: () => Promise<T>) => Promise<T>;
  appendStartupLog: (message: string) => void;
}

export function createSystemFontInstallRuntime(deps: SystemFontInstallRuntimeDeps): {
  installFontSystemWide: (item: FontItem) => Promise<InstallResult>;
  uninstallFontSystemWide: (item: FontItem | FontItem[]) => Promise<InstallResult>;
  deleteFontFilesToTrash: (items: FontItem[], watchedFolders: string[]) => Promise<FontDeleteResult>;
} {
  const recovery = createFontUninstallRecoveryRuntime(deps);
  async function installFontSystemWide(item: FontItem): Promise<InstallResult> {
    deps.ensureWindows();
    await fsp.access(item.path);

    const fontsDir = deps.currentUserFontsDir();
    await deps.activationTraceStep("ensure-user-fonts-dir", item.id, () =>
      fsp.mkdir(fontsDir, { recursive: true }),
    );

    const original = basename(item.path).replace(/[<>:"/\\|?*]/g, "_");
    const ext = extname(original) || extname(item.fileName) || ".ttf";
    const copyName = original || `${fontFileNameToken(item.id)}${ext}`;
    const fallbackDest = join(fontsDir, copyName);
    const installed = await deps.getSystemInstalledFontsCached(true);
    const dest = installOverwriteTarget(item, installed, fontsDir, fallbackDest, deps);

    const source = deps.normalizePathForCacheCompare(resolve(item.path));
    const target = deps.normalizePathForCacheCompare(resolve(dest));
    const replacing = fs.existsSync(dest) && source !== target;
    const performInstall = async (check: () => Promise<void>) => {
      if ((await deps.openUninstallReceipts()).load(item.path)) throw new Error('此来源仍有未完成卸载，请先重试核验原卸载目标。');
      if (source !== target) {
        await check();
        await fsp.copyFile(item.path, dest);
      }
      await check();
      await deps.writeFontRegistryValuesHKCUBatch([{ name: deps.registryNameFor(item), path: dest }]);
    };
    const registryTargets = installed.filter(record => record.source === 'HKCU' && record.registryName.toLowerCase() === deps.registryNameFor(item).toLowerCase());
    if (registryTargets.some(record => !record.path)) return { ok: false, message: '保护状态未知，已有安装记录缺少文件路径，未执行。' };
    await deps.withFontProtection([{ ...item, path: dest }, ...registryTargets.map(record => ({ ...item, path: record.path! }))], performInstall);

    deps.clearInstalledFontsMemoryCache();

    return {
      ok: true,
      message: replacing
        ? "已覆盖安装到 Windows 当前用户字体目录。为避免资源管理器卡死，本版不会强制刷新 Explorer。"
        : "已安装到 Windows 当前用户字体目录。为避免资源管理器卡死，本版不会强制刷新 Explorer。",
    };
  }

  function batchSession() {
    let pending: Promise<FontMutationSession> | undefined;
    return {
      get: () => pending ||= (deps.createMutationSession?.() || createFontMutationSession(deps.appendStartupLog)),
      close: async () => { if (pending) { try { (await pending).close(); } catch { /* Failed creation has no live session. */ } } },
    };
  }

  async function readUninstallRegistry(session: ReturnType<typeof batchSession>) {
    return deps.readUninstallRegistry?.() || (await session.get()).readRegistry();
  }

  async function prepareSourceDelete(item: FontItem, session: ReturnType<typeof batchSession>): Promise<InstallResult> {
    deps.ensureWindows();
    let completedSteps = 0;
    let stage = 'protection-preflight';
    let remainingPaths: string[] = [];
    const failed = (message: string): InstallResult => {
      deps.appendStartupLog(`font uninstall failure: ${JSON.stringify({ id: item.id, path: item.path, sourceDelete: true, stage, completedSteps, message })}`);
      const detail = remainingPaths.length ? `${message} 安装文件尚未清理完成：${remainingPaths.join('；')}。请核对失败原因后重试卸载。` : message;
      return { ok: false, message: detail, uninstall: { completedSteps, remainingPaths: [...remainingPaths], stage } };
    };
    try {
      await deps.withFontProtection([item], async () => undefined);
      stage = 'source-identity';
      const source: InstallSourceIdentity = await readFontMutationIdentity(item.path);
      stage = 'registry-snapshot';
      const registry = await readUninstallRegistry(session);
      stage = 'installed-fonts';
      const installed = await deps.getSystemInstalledFonts();
      stage = 'uninstall-plan';
      const plannedTargets = new Map<string, InstallSourceIdentity>();
      const candidates = [...registry, ...installed].filter(record => record.path && deps.normalizePathForCacheCompare(record.path) === deps.normalizePathForCacheCompare(source.path));
      const plans = !candidates.length ? [] : await planFontUninstall(item, candidates, registry,
        [deps.currentUserFontsDir(), deps.windowsFontsDir()], deps.isTemporaryActiveInstalledRecord, {
          source, appName: deps.appName,
          onTarget: target => plannedTargets.set(deps.normalizePathForCacheCompare(target.path), target),
          report: evidence => { deps.appendStartupLog(`font uninstall evidence: ${JSON.stringify({ id: item.id, ...evidence })}`); },
        });
      remainingPaths = plans.filter(plan => plan.delete_file).map(plan => plan.path);
      const targets = [item, { ...item, path: source.path }, ...plans.map(plan => ({ ...item, path: plan.path }))];
      stage = 'target-protection';
      return await deps.withFontProtection(targets, async checkProtection => {
        const check = async () => {
          await checkProtection();
          const current = await readInstallSourceIdentity(item);
          if (current.path !== source.path || current.sha256 !== source.sha256 || current.stamp !== source.stamp || !!current.historical !== !!source.historical) throw new Error('源字体身份已变化，后续操作停止。');
        };
        stage = 'source-deactivation';
        await check();
        const deactivated = await deps.deactivateForFileDelete([item]);
        if (!deactivated.ok) throw new Error(`关联激活清理未完成：${deactivated.message}`);
        stage = 'mutation-session';
        const native = plans.length ? await session.get() : undefined;
        for (const plan of plans) {
          // Deleting the selected installation source uses its recycle-bin
          // operation below, never the native permanent installation cleanup.
          if (deps.normalizePathForCacheCompare(plan.path) === deps.normalizePathForCacheCompare(source.path) && plan.delete_file) continue;
          stage = plan.delete_file ? 'file-delete' : 'registry-delete';
          const result = await native!.execute({ ...plan, preflight_file: false, allow_readonly_copy: false }, async references => {
            await check();
            const expected = plannedTargets.get(deps.normalizePathForCacheCompare(plan.path));
            const currentTarget = await readFontMutationIdentity(plan.path);
            if (!expected || currentTarget.path !== expected.path || currentTarget.sha256 !== expected.sha256 || fontPhysicalKey(currentTarget) !== fontPhysicalKey(expected)) throw new Error('安装目标身份已变化，文件和后续登记操作保留，需重新核对。');
            if (plan.delete_file) {
              // Before the first native request no gate snapshot exists yet.
              // The native file gate always provides the original user's fresh snapshot.
              if (references && references.some(record => record.path && deps.normalizePathForCacheCompare(record.path) === deps.normalizePathForCacheCompare(plan.path))) throw new Error('安装引用已变化，文件保留，需重新核对后重试。');
            }
          });
          completedSteps += result.completedSteps;
          if (result.fileRemoved) remainingPaths = remainingPaths.filter(path => path !== plan.path);
          if (!result.ok) return failed(`已确认完成 ${completedSteps} 个步骤。${result.message}`);
        }
        deps.clearInstalledFontsMemoryCache();
        stage = 'persist-result';
        const installCompare = plans.length ? await deps.persistUninstallResult(item) : undefined;
        let refreshWarning = '';
        try { await deps.advancedFontRefresh('uninstall-font'); } catch (error) { refreshWarning = ` 字体通知失败：${String(error)}`; }
        return { ok: true, installCompare: installCompare || undefined, message: '计划内关联登记与独立安装副本已处理；所选源文件及其属性保留。' + refreshWarning };
      });
    } catch (error) {
      return failed(`${completedSteps ? `已完成 ${completedSteps} 个步骤，后续已停止：` : ''}${error instanceof Error ? error.message : String(error)}`);
    } finally { deps.clearInstalledFontsMemoryCache(); }
  }

  async function uninstallFontSystemWide(input: FontItem | FontItem[]): Promise<InstallResult> {
    const items = Array.isArray(input) ? input : [input];
    if (!items.length || items.length > 1000 || items.some(item => !item?.id || !item.path)) return { ok: false, message: '卸载目标为空或超过批量上限。' };
    const session = batchSession();
    const results: Record<string, InstallResult> = {};
    const byPath = new Map<string, InstallResult>();
    try { for (const item of items) {
      const key = deps.normalizePathForCacheCompare(item.path);
      const result = byPath.get(key) || await recovery.uninstall(item, session);
      byPath.set(key, result); results[item.id] = result;
    } }
    finally { await session.close(); }
    if (!Array.isArray(input)) return results[input.id];
    return { ok: Object.values(results).every(result => result.ok), message: '批量卸载已结束，请核对逐项结果。', results };
  }

  async function deleteFontFilesToTrash(items: FontItem[], watchedFolders: string[]): Promise<FontDeleteResult> {
    const session = batchSession();
    try {
      return await deleteFontFilesToTrashRuntime(items, watchedFolders, {
        ...deps,
        prepareSourceDelete: async item => {
          const result = await prepareSourceDelete(item, session);
          if (!result.ok) throw new Error(result.message);
        },
      });
    } finally { await session.close(); }
  }

  return {
    installFontSystemWide,
    uninstallFontSystemWide,
    deleteFontFilesToTrash,
  };
}
