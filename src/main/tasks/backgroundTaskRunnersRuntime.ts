import type {
FontItem,
InstallCompareResult,
ScanResult,
SystemInstalledFont,
} from "../../shared/types";
import {
parseBackgroundTaskPayload,
type BackgroundTaskRecord,
} from "./backgroundTasks";

export interface BackgroundTaskRunnersRuntimeOptions {
  normalizePathForCacheCompare: (filePath: string) => string;
  findFontItemInRootIndexes: (
    fontId: string,
    normalizedPath: string,
  ) => Promise<FontItem | null>;
  skipBackgroundTask: (taskKey: string, message: string) => Promise<void>;
  heartbeatBackgroundTask: (
    taskKey: string,
    progress: number,
    message: string,
  ) => Promise<void>;
  completeBackgroundTask: (taskKey: string, message: string) => Promise<void>;
  getSystemInstalledFontsCached: (
    force?: boolean,
  ) => Promise<SystemInstalledFont[]>;
  compareFontInstalledWithList: (
    item: FontItem,
    installed: SystemInstalledFont[],
  ) => InstallCompareResult;
  saveInstallStatusIndex: (
    results: Record<string, InstallCompareResult>,
    itemsById: Map<string, FontItem>,
  ) => Promise<void>;
  ensureFontPreviewImageFile: (
    item: FontItem,
    text: string,
    fontSize: number,
    width: number,
    height: number,
    force: boolean,
    returnDataUrl: boolean,
  ) => Promise<unknown>;
  withGlobalIo: <T>(
    label: string,
    fn: () => Promise<T>,
    options?: { priority?: "foreground" | "background"; storagePath?: string },
  ) => Promise<T>;
  scanFolders: (folders: string[], knownFonts: FontItem[]) => Promise<ScanResult>;
  runDatabaseMaintenance: (options: {
    createBackup?: boolean;
  }) => Promise<{ ok: boolean }>;
}

export interface BackgroundTaskRunnersRuntime {
  previewTaskKey: (previewKey: string) => string;
  runInstallStatusTask: (task: BackgroundTaskRecord) => Promise<void>;
  runPreviewCacheTask: (task: BackgroundTaskRecord) => Promise<void>;
  runScanRootTask: (task: BackgroundTaskRecord) => Promise<void>;
  runMaintenanceTask: (task: BackgroundTaskRecord) => Promise<void>;
}

export function createBackgroundTaskRunnersRuntime(
  options: BackgroundTaskRunnersRuntimeOptions,
): BackgroundTaskRunnersRuntime {
  async function findFontItemForTask(
    payload: Record<string, unknown>,
  ): Promise<FontItem | null> {
    const fontId = typeof payload.fontId === "string" ? payload.fontId : "";
    const fontPath =
      typeof payload.path === "string"
        ? options.normalizePathForCacheCompare(payload.path)
        : "";
    return options.findFontItemInRootIndexes(fontId, fontPath);
  }

  async function runInstallStatusTask(
    task: BackgroundTaskRecord,
  ): Promise<void> {
    const payload = parseBackgroundTaskPayload(task);
    const item = await findFontItemForTask(payload);
    if (!item) {
      await options.skipBackgroundTask(
        task.task_key,
        "字体已不存在，跳过安装状态检查。",
      );
      return;
    }
    await options.heartbeatBackgroundTask(
      task.task_key,
      0.25,
      "正在读取系统字体安装状态。",
    );
    const installed = await options.getSystemInstalledFontsCached(false);
    await options.heartbeatBackgroundTask(
      task.task_key,
      0.7,
      "正在比较字体安装状态。",
    );
    const result = options.compareFontInstalledWithList(item, installed);
    await options.saveInstallStatusIndex(
      { [item.id]: result },
      new Map([[item.id, item]]),
    );
  }

  async function runPreviewCacheTask(
    task: BackgroundTaskRecord,
  ): Promise<void> {
    const payload = parseBackgroundTaskPayload(task);
    const item = await findFontItemForTask(payload);
    if (!item) {
      await options.skipBackgroundTask(
        task.task_key,
        "字体已不存在，跳过预览缓存。",
      );
      return;
    }
    const text =
      typeof payload.text === "string" && payload.text
        ? payload.text
        : "字体预览 AaBb 123";
    const fontSize = Math.max(
      8,
      Math.min(240, Number(payload.fontSize || 44) || 44),
    );
    const width = Math.max(
      160,
      Math.min(4096, Number(payload.width || 720) || 720),
    );
    const height = Math.max(
      80,
      Math.min(2048, Number(payload.height || 260) || 260),
    );
    await options.withGlobalIo(
      "preview:background-task",
      () =>
        options.ensureFontPreviewImageFile(
          item,
          text,
          fontSize,
          width,
          height,
          true,
          false,
        ),
      { priority: "background", storagePath: item.path },
    );
  }

  async function runScanRootTask(task: BackgroundTaskRecord): Promise<void> {
    const payload = parseBackgroundTaskPayload<{
      folders?: unknown;
      knownFonts?: unknown;
    }>(task);
    const folders = Array.isArray(payload.folders)
      ? payload.folders.filter(
          (item): item is string => typeof item === "string" && !!item,
        )
      : [];
    if (!folders.length) {
      await options.skipBackgroundTask(
        task.task_key,
        "没有可扫描的监听文件夹。",
      );
      return;
    }
    const knownFonts = Array.isArray(payload.knownFonts)
      ? (payload.knownFonts.filter(Boolean) as FontItem[])
      : [];
    await options.heartbeatBackgroundTask(
      task.task_key,
      0.05,
      `准备扫描 ${folders.length} 个文件夹。`,
    );
    const result = await options.scanFolders(folders, knownFonts);
    await options.completeBackgroundTask(
      task.task_key,
      `扫描完成：索引文件 ${result.stats?.totalFiles ?? 0} 个，错误 ${result.errors.length} 个。`,
    );
  }

  async function runMaintenanceTask(task: BackgroundTaskRecord): Promise<void> {
    await options.heartbeatBackgroundTask(
      task.task_key,
      0.1,
      "正在执行数据库维护。",
    );
    const report = await options.runDatabaseMaintenance({ createBackup: false });
    await options.completeBackgroundTask(
      task.task_key,
      report.ok ? "数据库维护完成。" : "数据库维护完成，但存在异常。",
    );
  }

  return {
    previewTaskKey: (previewKey: string) => `preview_cache:${previewKey}`,
    runInstallStatusTask,
    runPreviewCacheTask,
    runScanRootTask,
    runMaintenanceTask,
  };
}
