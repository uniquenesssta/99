import { promises as fsp } from "node:fs";
import { basename,resolve } from "node:path";
import type { FolderCacheRepairStatus,FontIndexChangePayload,WatchedFolderRefreshResult } from "../../../shared/types";
import { pathInsideFolder } from "../../folders/physicalFolders";
import type { ManualFolderCacheRepairRuntime } from "./manualFolderCacheRepairRuntime";
import type { ManualFolderRefreshBackgroundRuntime } from "./manualFolderRefreshBackgroundRuntime";
import type { ManualFolderIndexApplyRuntime } from "./manualFolderIndexApplyRuntime";
import type { ManualFolderRefreshDeps } from "./manualFolderRefreshTypes";

export function createManualWatchedFolderRefreshRuntime(
  deps: ManualFolderRefreshDeps,
  cacheRepairRuntime: ManualFolderCacheRepairRuntime,
  indexApplyRuntime: ManualFolderIndexApplyRuntime,
  backgroundRuntime: ManualFolderRefreshBackgroundRuntime,
) {
  const {
    appendStartupLog,
    withGlobalIo,
    emitFontIndexProgress,
    createFontScanJobId,
    appWatchedFolders,
    findBestWatchedRootForFile,
    scanFoldersRuntime,
    sendFontIndexChanged,
    syncMergedIndexForRootSnapshot,
    syncMergedIndexForRootIncremental,
  } = deps;
  const { repairRootIndexCacheIfNeeded, repairRootPreviewCacheIfNeeded } = cacheRepairRuntime;
  const { applyManualFolderRefreshToIndex } = indexApplyRuntime;

  async function runWatchedFolderRefreshJob(args: {
    startedAt: number;
    resolvedFolder: string;
    bestRoot: string;
    jobId: string;
  }): Promise<WatchedFolderRefreshResult> {
    const { startedAt, resolvedFolder, bestRoot, jobId } = args;
    const indexRepair = await repairRootIndexCacheIfNeeded(bestRoot);
    const previewRepair = await repairRootPreviewCacheIfNeeded(bestRoot);
    const cacheRepairs: FolderCacheRepairStatus[] = [indexRepair, previewRepair];

    let mode: WatchedFolderRefreshResult["mode"] = "cache-read";
    let upserts = 0;
    let deletes = 0;
    let errors = 0;
    let totalFiles = 0;
    let parsed = 0;
    let fromCache = 0;
    let skippedBad = 0;
    let workerCount = 0;
    let mergedIndexRefreshPayload: FontIndexChangePayload | null = null;

    try {
      if (indexRepair.rebuildRequired) {
        mode = "repair-rebuild";
        emitFontIndexProgress({
          jobId,
          stage: "parsing",
          message: "索引缓存异常或缺失，正在覆盖性重建该监听根目录索引……",
          at: new Date().toISOString(),
          folders: [bestRoot],
        });
        const rebuilt = await scanFoldersRuntime().scanFoldersManaged(
          [bestRoot],
          [],
        );
        totalFiles = rebuilt.stats?.totalFiles || 0;
        parsed = rebuilt.stats?.parsed || 0;
        fromCache = rebuilt.stats?.fromCache || 0;
        skippedBad = rebuilt.stats?.skippedBad || 0;
        errors = rebuilt.errors.length;
        sendFontIndexChanged({
          folder: bestRoot,
          at: new Date().toISOString(),
          upserts: rebuilt.fonts || [],
          deletes: [],
          errors: rebuilt.errors,
        });
      } else {
        emitFontIndexProgress({
          jobId,
          stage: "evaluating",
          message: "缓存正常，正在检测该文件夹是否有新增、修改或删除的字体……",
          at: new Date().toISOString(),
          folders: [resolvedFolder],
        });
        const refreshed = await applyManualFolderRefreshToIndex(
          bestRoot,
          resolvedFolder,
          jobId,
        );
        upserts = refreshed.payload.upserts.length;
        deletes = refreshed.payload.deletes.length;
        errors = refreshed.payload.errors?.length || 0;
        totalFiles = refreshed.totalFiles;
        parsed = refreshed.parsed;
        fromCache = refreshed.fromCache;
        skippedBad = refreshed.skippedBad;
        workerCount = refreshed.workerCount;
        mode = upserts || deletes || errors ? "incremental" : "cache-read";
        mergedIndexRefreshPayload = refreshed.payload;
        sendFontIndexChanged(refreshed.payload);
      }

      if (mode === "repair-rebuild") {
        await syncMergedIndexForRootSnapshot(
          bestRoot,
          `manual-folder-refresh-repair:${bestRoot}`,
        );
      } else if (mergedIndexRefreshPayload && (upserts || deletes)) {
        await syncMergedIndexForRootIncremental(
          bestRoot,
          mergedIndexRefreshPayload,
          `manual-folder-refresh:${bestRoot}`,
        );
      }

      const elapsedMs = Date.now() - startedAt;
      const repairedCount = cacheRepairs.filter((item) => item.repaired).length;
      const message =
        mode === "repair-rebuild"
          ? `文件夹刷新完成：已修复 ${repairedCount} 个缓存文件并覆盖重建索引，索引 ${totalFiles} 个字体，跳过 ${skippedBad} 个，用时 ${Math.round(elapsedMs / 1000)} 秒。`
          : mode === "incremental"
            ? `文件夹刷新完成：缓存正常，检测到新增/更新 ${upserts} 个、删除 ${deletes} 个，重新解析 ${parsed} 个，复用 ${fromCache} 个${workerCount ? `，Worker ${workerCount} 个` : ""}，用时 ${Math.round(elapsedMs / 1000)} 秒。`
            : `文件夹刷新完成：缓存正常，没有发现新增或删除字体，已重新读取缓存，复用 ${fromCache} 个，用时 ${Math.round(elapsedMs / 1000)} 秒。`;

      emitFontIndexProgress({
        jobId,
        stage: "done",
        message,
        at: new Date().toISOString(),
        folders: [resolvedFolder],
        totalFiles,
        parsedFiles: parsed,
        fromCache,
        skippedBad,
        durationMs: elapsedMs,
        errors,
      });
      appendStartupLog(
        `manual watched folder refresh finished: root=${bestRoot}, folder=${resolvedFolder}, mode=${mode}, repairs=${repairedCount}, upserts=${upserts}, deletes=${deletes}, files=${totalFiles}, elapsed=${elapsedMs}ms`,
      );

      return {
        ok: true,
        folder: resolvedFolder,
        rootPath: bestRoot,
        mode,
        cacheRepairs,
        upserts,
        deletes,
        errors,
        totalFiles,
        parsed,
        fromCache,
        skippedBad,
        workerCount,
        elapsedMs,
        jobId,
        message,
      };
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const message = `文件夹刷新失败：${error instanceof Error ? error.message : String(error)}`;
      emitFontIndexProgress({
        jobId,
        stage: "error",
        message,
        at: new Date().toISOString(),
        folders: [resolvedFolder],
        durationMs: elapsedMs,
        errors: 1,
      });
      appendStartupLog(
        `manual watched folder refresh failed: root=${bestRoot}, folder=${resolvedFolder}, ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async function refreshWatchedFolder(
    folderPath: string,
    rootPath?: string,
  ): Promise<WatchedFolderRefreshResult> {
    const startedAt = Date.now();
    const resolvedFolder = resolve(folderPath || "");
    const watchedFolders = await appWatchedFolders().catch(() => []);
    const providedRoot = rootPath ? resolve(rootPath) : "";
    const bestRoot =
      providedRoot && pathInsideFolder(resolvedFolder, providedRoot)
        ? providedRoot
        : findBestWatchedRootForFile(resolvedFolder, watchedFolders) ||
          resolvedFolder;

    if (!bestRoot || !pathInsideFolder(resolvedFolder, bestRoot)) {
      throw new Error("刷新目标不在任何已监听字体文件夹内。");
    }

    const stat = await withGlobalIo(
      "manual-refresh:stat-folder",
      () => fsp.stat(resolvedFolder),
      { priority: "foreground", storagePath: resolvedFolder },
    );
    if (!stat.isDirectory()) throw new Error("刷新目标不是文件夹。");

    const activeKey = `${bestRoot}\n${resolvedFolder}`;
    const active = backgroundRuntime.activeRefresh(activeKey);
    if (active) {
      return backgroundRuntime.backgroundResult({
        folder: resolvedFolder,
        rootPath: bestRoot,
        jobId: active.jobId,
        elapsedMs: Date.now() - startedAt,
        message: `“${basename(resolvedFolder) || resolvedFolder}”正在后台刷新，前端不会等待完整 NAS 扫描。`,
      });
    }

    const jobId = createFontScanJobId();
    emitFontIndexProgress({
      jobId,
      stage: "start",
      message: `正在后台刷新文件夹：${basename(resolvedFolder) || resolvedFolder}，前端不再等待完整扫描……`,
      at: new Date().toISOString(),
      folders: [resolvedFolder],
    });

    const scheduled = backgroundRuntime.scheduleRefresh(activeKey, jobId, async () => {
      await runWatchedFolderRefreshJob({
        startedAt: Date.now(),
        resolvedFolder,
        bestRoot,
        jobId,
      });
    });
    appendStartupLog(
      `manual watched folder refresh scheduled background: root=${bestRoot}, folder=${resolvedFolder}, job=${scheduled.jobId}, scheduled=${scheduled.scheduled}`,
    );

    return backgroundRuntime.backgroundResult({
      folder: resolvedFolder,
      rootPath: bestRoot,
      jobId: scheduled.jobId,
      elapsedMs: Date.now() - startedAt,
      message: `已开始后台刷新“${basename(resolvedFolder) || resolvedFolder}”。前端会继续保持可操作，完成后自动推送索引变更。`,
    });
  }

  return { refreshWatchedFolder };
}

export type ManualWatchedFolderRefreshRuntime = ReturnType<typeof createManualWatchedFolderRefreshRuntime>;
