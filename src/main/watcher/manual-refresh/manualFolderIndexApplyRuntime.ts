import { resolve } from "node:path";
import type { FontIndexChangePayload,FontIndexProgressPayload } from "../../../shared/types";
import type { FontParseJob,FontParseWorkerResult } from "../../indexing/fontScanWorkers";
import { nodeFontkitScanFallbackEnabled,rustFullMigrationEnabled } from "../../rust-core/rustFullMigrationPolicyRuntime";
import type { FontScanCacheEntry } from "../../indexing/rootIndexRuntime";
import { buildFontParseResultFromRustMetadata } from "../../indexing/scan-orchestrator/rustMetadataFastPathRuntime";
import { consumeRustFontParseBatchFastPath } from "../../indexing/scan-orchestrator/rustParseBatchFastPathRuntime";
import type { ManualFolderIndexEntryRuntime } from "./manualFolderIndexEntryRuntime";
import type { ManualFolderRefreshDeps } from "./manualFolderRefreshTypes";
import { createManualFolderRustListingRuntime,type ManualRefreshListedFont } from "./manualFolderRustListingRuntime";

export function createManualFolderIndexApplyRuntime(
  deps: ManualFolderRefreshDeps,
  indexRuntime: ManualFolderIndexEntryRuntime,
) {
  const {
    scriptDetectionVersion: SCRIPT_DETECTION_VERSION,
    fontScanCacheVersion: FONT_SCAN_CACHE_VERSION,
    appendStartupLog,
    fileCacheSignature,
    cacheKeyForRootFile,
    sanitizeCachedFont,
    cachedFontForRuntime,
    ensureRootScanCacheStorage,
    saveRootIndexSqliteChanges,
    saveScanCacheFile,
    writeRootCacheManifest,
    runFontParseWorkerPool,
    scanWorkerCount,
    invalidateSharedFontRuntimeCaches,
    emitFontIndexProgress,
    delayToEventLoop,
    isRootIndexDbPath,
  } = deps;

  const {
    fontIndexDeleteRecord,
    makeRootScanCacheContext,
    fontIndexEntryChanged,
    relativeDirectoryPathForRoot,
    cacheKeyInsideDirectory,
    saveRootDirectorySignatures,
    listFontFilesWithDirectoryCache,
  } = indexRuntime;
  const { tryListManualRefreshWithRust } = createManualFolderRustListingRuntime(
    deps,
    relativeDirectoryPathForRoot,
  );

  async function applyManualFolderRefreshToIndex(
    rootPath: string,
    targetFolder: string,
    jobId?: string,
  ): Promise<{
    payload: FontIndexChangePayload;
    totalFiles: number;
    parsed: number;
    fromCache: number;
    skippedBad: number;
    durationMs: number;
    workerCount: number;
  }> {
    const startedAt = Date.now();
    const resolvedRoot = resolve(rootPath);
    const resolvedTarget = resolve(targetFolder);
    const payload: FontIndexChangePayload = {
      folder: resolvedRoot,
      at: new Date().toISOString(),
      upserts: [],
      deletes: [],
      errors: [],
    };

    const storage = await ensureRootScanCacheStorage(resolvedRoot);
    const context = makeRootScanCacheContext(resolvedRoot, storage);
    const changedEntryMap = new Map<string, FontScanCacheEntry>();
    const deletedKeySet = new Set<string>();
    let parsed = 0;
    let fromCache = 0;
    let skippedBad = 0;
    let workerCount = 0;

    const emitManualRefreshProgress = (
      stage: FontIndexProgressPayload["stage"],
      message: string,
      extra: Partial<FontIndexProgressPayload> = {},
    ): void => {
      if (!jobId) return;
      emitFontIndexProgress({
        jobId,
        stage,
        message,
        at: new Date().toISOString(),
        folders: [resolvedTarget],
        ...extra,
      });
    };

    const reportListingProgress = (progress: {
      files: number;
      foldersScanned: number;
      skippedDirs: number;
    }): void => {
      emitManualRefreshProgress(
        "listing",
        `正在列出该文件夹字体：已发现 ${progress.files} 个，扫描目录 ${progress.foldersScanned} 个，跳过未变化目录 ${progress.skippedDirs} 个。`,
        { listedFiles: progress.files },
      );
    };

    const rustListed = await tryListManualRefreshWithRust({
      rootPath: resolvedRoot,
      targetFolder: resolvedTarget,
      context,
      errors: payload.errors || [],
      progress: reportListingProgress,
    });

    const rows: ManualRefreshListedFont[] =
      rustListed?.rows ||
      (await listFontFilesWithDirectoryCache(
        context,
        payload.errors || [],
        reportListingProgress,
        undefined,
        resolvedTarget,
      ));

    const totalFiles = rows.length;
    const seenKeysInTarget = new Set<string>();
    const relativeTargetDir = relativeDirectoryPathForRoot(
      resolvedRoot,
      resolvedTarget,
    );
    const parseJobs: FontParseJob[] = [];

    emitManualRefreshProgress(
      "evaluating",
      `正在对比该文件夹索引：${totalFiles} 个字体文件。`,
      { totalFiles, listedFiles: totalFiles },
    );

    let evaluated = 0;
    for (const row of rows) {
      evaluated += 1;
      if (evaluated % 500 === 0) {
        emitManualRefreshProgress(
          "evaluating",
          `正在对比该文件夹索引：${evaluated}/${totalFiles}，复用 ${fromCache}，待解析 ${parseJobs.length}。`,
          { totalFiles, stattedFiles: evaluated, fromCache, skippedBad },
        );
        await delayToEventLoop();
      }

      if (!row.stat) {
        payload.errors?.push({
          path: row.file,
          message: row.error || "读取文件状态失败。",
        });
        continue;
      }

      const file = row.file;
      const stat = row.stat;
      const key = cacheKeyForRootFile(resolvedRoot, file);
      const signature = fileCacheSignature(key, stat.size, stat.mtimeMs);
      const createdAt = stat.birthtimeMs || stat.ctimeMs || stat.mtimeMs;
      const existing = context.cache.entries[key];
      seenKeysInTarget.add(key);
      context.seenKeys.add(key);

      if (existing && existing.cacheKey === signature) {
        if (
          existing.status === "ok" &&
          existing.font &&
          Array.isArray(existing.font.scripts) &&
          existing.font.scripts.length &&
          existing.font.scriptVersion === SCRIPT_DETECTION_VERSION
        ) {
          fromCache += 1;
          continue;
        }
        if (existing.status === "bad") {
          fromCache += 1;
          continue;
        }
      }

      parseJobs.push({
        jobId: `manual-${parseJobs.length}`,
        rootPath: resolvedRoot,
        filePath: file,
        fileSize: stat.size,
        modifiedAt: stat.mtimeMs,
        createdAt,
        cacheKey: key,
        signature,
        signatureValid: row.signatureValid === undefined ? undefined : row.signatureValid === true,
        formatHint: row.formatHint,
        quickHash: row.quickHash,
        contentHash: row.contentHash || row.quickHash,
        hashKind: row.hashKind,
        nameHint: row.nameHint,
        scriptHint: row.scriptHint,
        styleHint: row.styleHint,
        familyHint: row.familyHint,
      });
    }

    emitManualRefreshProgress(
      "parsing",
      parseJobs.length
        ? `后台 Worker 正在解析该文件夹新增/变更字体：0/${parseJobs.length}。`
        : "没有新增或变更字体需要解析。",
      {
        totalFiles,
        parsedFiles: 0,
        fromCache,
        skippedBad,
        workerCount: scanWorkerCount(parseJobs.length, [resolvedRoot]),
      },
    );

    let processedWorkerResults = 0;
    const processWorkerResult = async (
      result: FontParseWorkerResult,
    ): Promise<void> => {
      processedWorkerResults += 1;
      if (processedWorkerResults % 500 === 0) await delayToEventLoop();

      const oldEntry = context.cache.entries[result.cacheKey];

      if (result.status === "bad") {
        const nextEntry: FontScanCacheEntry = {
          path: result.cacheKey,
          cacheKey: result.signature,
          fileSize: result.fileSize,
          modifiedAt: result.modifiedAt,
          createdAt: result.createdAt,
          status: "bad",
          message: result.message || "不是有效字体签名，已跳过。",
          contentHash: result.contentHash || result.quickHash,
          cachedAt: new Date().toISOString(),
        };
        context.cache.entries[result.cacheKey] = nextEntry;
        if (fontIndexEntryChanged(oldEntry, nextEntry)) {
          changedEntryMap.set(result.cacheKey, nextEntry);
          deletedKeySet.delete(result.cacheKey);
          skippedBad += 1;
        }
        return;
      }

      if (result.status === "error" || !result.font) {
        payload.errors?.push({
          path: result.filePath,
          message: result.message || "Worker 解析失败。",
        });
        return;
      }

      const stat = {
        size: result.fileSize,
        mtimeMs: result.modifiedAt,
        birthtimeMs: result.createdAt,
        ctimeMs: result.createdAt,
      };
      const cachedFont = sanitizeCachedFont(
        result.font,
        result.cacheKey,
        result.filePath,
        stat,
      );
      const nextEntry: FontScanCacheEntry = {
        path: result.cacheKey,
        cacheKey: result.signature,
        fileSize: result.fileSize,
        modifiedAt: result.modifiedAt,
        createdAt: result.createdAt,
        status: "ok",
        font: cachedFont,
        contentHash: result.contentHash || result.quickHash,
        cachedAt: new Date().toISOString(),
      };
      context.cache.entries[result.cacheKey] = nextEntry;

      if (fontIndexEntryChanged(oldEntry, nextEntry)) {
        changedEntryMap.set(result.cacheKey, nextEntry);
        deletedKeySet.delete(result.cacheKey);
        payload.upserts.push(
          cachedFontForRuntime(
            cachedFont,
            result.filePath,
            stat,
            result.cacheKey,
          ),
        );
      }
      parsed += 1;
    };

    const workerParseJobs: FontParseJob[] = [];
    let rustFastPathParsed = 0;
    for (const job of parseJobs) {
      const fastResult = buildFontParseResultFromRustMetadata(
        job,
        SCRIPT_DETECTION_VERSION,
      );
      if (fastResult) {
        rustFastPathParsed += 1;
        await processWorkerResult(fastResult);
        if (rustFastPathParsed % 200 === 0) {
          emitManualRefreshProgress(
            "parsing",
            `Rust 元数据快速整理该文件夹：${processedWorkerResults}/${parseJobs.length}。`,
            {
              totalFiles,
              parsedFiles: processedWorkerResults,
              fromCache,
              skippedBad,
              workerCount: 0,
            },
          );
          await delayToEventLoop();
        }
        continue;
      }
      workerParseJobs.push(job);
    }

    if (rustFastPathParsed > 0) {
      appendStartupLog(
        `manual folder rust metadata fast path used: fast=${rustFastPathParsed}, fallbackWorker=${workerParseJobs.length}`,
      );
    }

    const rustBatch = await consumeRustFontParseBatchFastPath({
      jobs: workerParseJobs,
      scriptDetectionVersion: SCRIPT_DETECTION_VERSION,
      runRustFontParseBatch: deps.runRustFontParseBatch,
      processResult: processWorkerResult,
      appendStartupLog,
      logPrefix: "manual folder rust parse batch fast path",
      progress: () => {
        emitManualRefreshProgress(
          "parsing",
          `Rust 批量解析该文件夹新增/变更字体：${processedWorkerResults}/${parseJobs.length}。`,
          {
            totalFiles,
            parsedFiles: processedWorkerResults,
            fromCache,
            skippedBad,
            workerCount: 0,
          },
        );
      },
      delayToEventLoop,
    });

    if (rustFullMigrationEnabled() && !nodeFontkitScanFallbackEnabled() && rustBatch.remainingJobs.length && (rustBatch.consumed > 0 || rustBatch.errors > 0)) {
      appendStartupLog(`manual folder rust full migration: node fontkit fallback disabled, unresolved=${rustBatch.remainingJobs.length}`);
      for (const job of rustBatch.remainingJobs) {
        await processWorkerResult({
          ...job,
          status: "error",
          message: "Rust 扫描解析未能完整识别；Node/fontkit 兜底已按 Rust 全量迁移策略禁用。",
        });
      }
      workerCount = 0;
    } else {
      const workerResult = await runFontParseWorkerPool(
        rustBatch.remainingJobs,
        (progress) => {
          emitManualRefreshProgress(
            "parsing",
            `后台 Worker 正在解析该文件夹新增/变更字体：${processedWorkerResults}/${parseJobs.length}。`,
            {
              totalFiles,
              parsedFiles: processedWorkerResults,
              fromCache,
              skippedBad,
              workerCount: progress.workerCount,
            },
          );
        },
        undefined,
        processWorkerResult,
      );
      workerCount = workerResult.workerCount;
    }

    for (const [key, entry] of Object.entries(context.cache.entries || {})) {
      if (!cacheKeyInsideDirectory(key, relativeTargetDir)) continue;
      if (seenKeysInTarget.has(key)) continue;
      changedEntryMap.delete(key);
      deletedKeySet.add(key);
      payload.deletes.push(fontIndexDeleteRecord(resolvedRoot, key, entry));
      delete context.cache.entries[key];
    }

    const changedEntries = Array.from(changedEntryMap.entries());
    const deletedKeys = Array.from(deletedKeySet);
    emitManualRefreshProgress(
      "writing",
      `正在写入该文件夹索引变更：新增/更新 ${changedEntries.length} 个，删除 ${deletedKeys.length} 个。`,
      {
        totalFiles,
        parsedFiles: parsed,
        fromCache,
        skippedBad,
        workerCount,
      },
    );

    if (changedEntries.length || deletedKeys.length) {
      if (isRootIndexDbPath(storage.cachePath)) {
        await saveRootIndexSqliteChanges(
          storage.cachePath,
          resolvedRoot,
          storage.storage,
          changedEntries,
          deletedKeys,
        );
      } else {
        await saveScanCacheFile(
          storage.cachePath,
          {
            version: FONT_SCAN_CACHE_VERSION,
            entries: context.cache.entries || {},
          },
          resolvedRoot,
          storage.storage,
        );
        await writeRootCacheManifest(
          storage.cacheDir,
          resolvedRoot,
          storage.storage,
          Object.keys(context.cache.entries || {}).length,
          storage.cachePath,
        );
      }
    }
    await saveRootDirectorySignatures(context);

    invalidateSharedFontRuntimeCaches();
    appendStartupLog(
      `manual folder refresh index applied: root=${resolvedRoot}, folder=${resolvedTarget}, total=${totalFiles}, parsed=${parsed}, cache=${fromCache}, skipped=${skippedBad}, upserts=${payload.upserts.length}, deletes=${payload.deletes.length}, workers=${workerCount}, durationMs=${Date.now() - startedAt}`,
    );
    return {
      payload,
      totalFiles,
      parsed,
      fromCache,
      skippedBad,
      durationMs: Date.now() - startedAt,
      workerCount,
    };
  }

  return { applyManualFolderRefreshToIndex };
}

export type ManualFolderIndexApplyRuntime = ReturnType<typeof createManualFolderIndexApplyRuntime>;
