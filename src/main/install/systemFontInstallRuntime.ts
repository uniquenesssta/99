import { planFontUninstall, readFontMutationIdentity } from "./fontUninstallPlanRuntime";
import { createFontMutationSession, type FontMutationSession } from "./fontMutationProcessRuntime";
import { fontFileNameToken } from '../fonts/fontFileIdentity'
import fs from 'node:fs';
import { sharedFileSystem as fsp } from '../path/sharedFileSystemRuntime';
import { basename,extname,join,resolve } from "node:path";
import type { FontDeleteResult,FontItem,InstallResult,SystemInstalledFont } from "../../shared/types";
import { deleteFontFilesToTrashRuntime } from "./fontTrashDeleteRuntime";
import { installOverwriteTarget } from "./systemFontInstallHelpersRuntime";

export interface SystemFontInstallRuntimeDeps {
  persistUninstallResult: (item: FontItem) => Promise<void>;
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

  async function uninstallOne(item: FontItem, session: ReturnType<typeof batchSession>, sourceDelete = false): Promise<InstallResult> {
    deps.ensureWindows();
    let completedSteps = 0;
    try {
      await deps.withFontProtection([item], async () => undefined);
      const source = await readFontMutationIdentity(item.path);
      const registry = await readUninstallRegistry(session);
      const installed = await deps.getSystemInstalledFonts();
      const candidates = sourceDelete ? [...registry, ...installed].filter(record => record.path && deps.normalizePathForCacheCompare(record.path) === deps.normalizePathForCacheCompare(source.path)) : [...registry, ...installed];
      const plans = sourceDelete && !candidates.length ? [] : await planFontUninstall(item, candidates, registry,
        [deps.currentUserFontsDir(), deps.windowsFontsDir()], deps.isTemporaryActiveInstalledRecord);
      if (!plans.length && !sourceDelete) return { ok: false, message: '未找到可以唯一关联的安装记录；没有按名称猜测删除。' };
      const targets = [item, { ...item, path: source.path }, ...plans.map(plan => ({ ...item, path: plan.path }))];
      return await deps.withFontProtection(targets, async checkProtection => {
        const check = async () => {
          await checkProtection();
          const current = await readFontMutationIdentity(item.path);
          if (current.path !== source.path || current.sha256 !== source.sha256) throw new Error('源字体身份已变化，后续操作停止。');
        };
        if (sourceDelete) {
          await check();
          const deactivated = await deps.deactivateForFileDelete([item]);
          if (!deactivated.ok) throw new Error(`关联激活清理未完成：${deactivated.message}`);
        }
        const native = plans.length ? await session.get() : undefined;
        for (const plan of plans) {
          // Deleting the selected installation source uses its recycle-bin
          // operation below, never the native permanent installation cleanup.
          if (sourceDelete && deps.normalizePathForCacheCompare(plan.path) === deps.normalizePathForCacheCompare(source.path) && plan.delete_file) continue;
          const result = await native!.execute(plan, async references => {
            await check();
            if (plan.delete_file) {
              // Before the first native request no gate snapshot exists yet.
              // The native file gate always provides the original user's fresh snapshot.
              if (references && references.some(record => record.path && deps.normalizePathForCacheCompare(record.path) === deps.normalizePathForCacheCompare(plan.path))) throw new Error('安装引用已变化，文件保留，需重新核对后重试。');
            }
          });
          completedSteps += result.completedSteps;
          if (!result.ok) return { ok: false, message: `已确认完成 ${completedSteps} 个步骤。${result.message}` };
        }
        deps.clearInstalledFontsMemoryCache();
        if (!sourceDelete || plans.length) await deps.persistUninstallResult(item);
        let refreshWarning = '';
        try { await deps.advancedFontRefresh('uninstall-font'); } catch (error) { refreshWarning = ` 字体通知失败：${String(error)}`; }
        return { ok: true, message: '关联安装记录与安装副本已清理，独立源文件保留。' + refreshWarning };
      });
    } catch (error) {
      return { ok: false, message: `${completedSteps ? `已完成 ${completedSteps} 个步骤，后续已停止：` : ''}${error instanceof Error ? error.message : String(error)}` };
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
      const result = byPath.get(key) || await uninstallOne(item, session);
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
          const result = await uninstallOne(item, session, true);
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
