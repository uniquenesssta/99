import { isAbsolute, relative, resolve } from "node:path";
import type { FontIndexChangePayload, FontIndexProgressPayload } from "../../../shared/types";
import type { FontScanCacheEntry } from "../../indexing/rootIndexRuntime";
import { currentSharedIoSignal } from "../../path/sharedFileSystemRuntime";
import type { SharedIoProcessError } from "../../path/sharedIoProcessRuntime";
import { throwIfAborted } from "../../performance/ioQueue";
import { normalizePathForCacheCompare } from "../../path/cachePath";
import { fontIndexCacheMissReason, type FontIndexBatchResult, type FontIndexFileInput } from "./fontIndexEntryBatchRuntime";
import type { ManualFolderIndexEntryRuntime } from "./manualFolderIndexEntryRuntime";
import type { ManualFolderRefreshDeps } from "./manualFolderRefreshTypes";
import { createManualFolderRustListingRuntime, type ManualRefreshListedFont } from "./manualFolderRustListingRuntime";

export function createManualFolderIndexApplyRuntime(deps: ManualFolderRefreshDeps, indexRuntime: ManualFolderIndexEntryRuntime) {
  const { tryListManualRefreshWithRust } = createManualFolderRustListingRuntime(deps);

  async function applyManualFolderRefreshToIndex(
    rootPath: string,
    targetFolder: string,
    jobId?: string,
    lifetime: { signal?: AbortSignal; assertCurrent?: () => void } = {},
  ) {
    const startedAt = Date.now();
    const signal = lifetime.signal || currentSharedIoSignal();
    const guard = () => { throwIfAborted(signal); lifetime.assertCurrent?.(); };
    try {
      guard();
      const resolvedRoot = resolve(rootPath), resolvedTarget = resolve(targetFolder);
      const targetRelative = relative(resolvedRoot, resolvedTarget);
      if (targetRelative === ".." || targetRelative.startsWith(`..\\`) || targetRelative.startsWith("../") || isAbsolute(targetRelative)) {
        throw new Error("刷新目标超出监听根目录。");
      }
      const payload: FontIndexChangePayload = { folder: resolvedRoot, at: new Date().toISOString(), upserts: [], deletes: [], errors: [] };
      const storage = await deps.ensureRootScanCacheStorage(resolvedRoot, { reuseExisting: true });
      guard();
      const context = indexRuntime.makeRootScanCacheContext(resolvedRoot, storage);
      // A cancelled/failed write must not publish speculative rows into the shared cache.
      const sourceCache = context.cache;
      context.cache = { ...sourceCache, entries: { ...sourceCache.entries } };
      context.requireFreshFileStats = true;
      context.assertCurrent = guard;
      const progress = (stage: FontIndexProgressPayload["stage"], message: string, extra: Partial<FontIndexProgressPayload> = {}) => {
        guard();
        if (jobId) deps.emitFontIndexProgress({ jobId, stage, message, at: new Date().toISOString(), folders: [resolvedTarget], ...extra });
      };
      const reportListing = (value: { files: number; foldersScanned: number; skippedDirs: number }) => progress("listing", `正在核对该文件夹文件属性：已发现 ${value.files} 个字体。`, { listedFiles: value.files });
      const native = await tryListManualRefreshWithRust({ rootPath: resolvedRoot, targetFolder: resolvedTarget, signal, progress: reportListing });
      guard();
      const rows: ManualRefreshListedFont[] = native?.rows || await indexRuntime.listFontFilesWithDirectoryCache(context, payload.errors!, reportListing, signal, resolvedTarget);
      guard();
      const seen = new Set<string>(), identities = new Set<string>();
      const inputs: FontIndexFileInput[] = [];
      const reasons: Record<string, number> = {};
      let fromCache = 0, addedFiles = 0, changedFiles = 0, metadataRepairs = 0, skippedBad = 0, repairDeletes = 0;
      const relativeTargetDir = indexRuntime.relativeDirectoryPathForRoot(resolvedRoot, resolvedTarget);
      progress("evaluating", `正在对比该文件夹索引：${rows.length} 个字体文件。`, { totalFiles: rows.length });
      // Validate every name before parsing or authorizing any missing-row delete.
      for (const row of rows) {
        guard();
        const rel = relative(resolvedTarget, row.file);
        const identity = normalizePathForCacheCompare(row.file);
        if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith(`..\\`) || isAbsolute(rel) || identities.has(identity)) {
          throw new Error("刷新目录快照包含越界或重复文件身份，已保留原索引。");
        }
        identities.add(identity);
        const key = deps.cacheKeyForRootFile(resolvedRoot, row.file);
        if (!key || !indexRuntime.cacheKeyInsideDirectory(key, relativeTargetDir) || seen.has(key)) throw new Error("刷新目录快照包含无效索引路径。");
        seen.add(key);
        context.seenKeys.add(key);
        if (!row.stat || row.error || !Number.isSafeInteger(row.stat.size) || row.stat.size < 0 || !Number.isFinite(row.stat.mtimeMs)) {
          payload.errors!.push({ path: row.file, message: row.error || "读取文件状态失败。" });
          continue;
        }
        const existing = context.cache.entries[key];
        const signature = deps.fileCacheSignature(key, row.stat.size, row.stat.mtimeMs);
        const reason = fontIndexCacheMissReason(existing, signature, row.stat, deps.scriptDetectionVersion);
        if (!reason) {
          fromCache++;
          if (existing?.status === "bad") {
            // This is projection repair, never evidence that a source file disappeared.
            payload.deletes.push(indexRuntime.fontIndexDeleteRecord(resolvedRoot, key, existing));
            repairDeletes++;
          }
          continue;
        }
        reasons[reason] = (reasons[reason] || 0) + 1;
        if (reason === "new-file") addedFiles++;
        else if (["size-changed", "modified-time-changed"].includes(reason)) changedFiles++;
        else metadataRepairs++;
        // Equal metadata permits reuse only. Concrete change notifications use the
        // watcher's forceVerify path; no metadata comparison proves byte equality.
        inputs.push({ file: row.file, freshStat: row.stat, requireSourceStability: true });
        if (inputs.length % 500 === 0) { await deps.delayToEventLoop(); guard(); }
      }
      progress("parsing", inputs.length ? `正在解析新增/变更及需修复的字体：${inputs.length} 个。` : "没有字体需要重新解析。", { totalFiles: rows.length, fromCache });
      const before = { ...context.cache.entries };
      const parsedResult: FontIndexBatchResult = { results: [], parsed: 0, misses: {} };
      // Match the watcher's bounded native parse batches; a large import must
      // not become one uninterruptible root-wide content-read request.
      for (let start = 0; start < inputs.length; start += 32) {
        guard();
        const batch = await indexRuntime.upsertFontIndexEntries(resolvedRoot, inputs.slice(start, start + 32), context.cache, signal, guard);
        guard();
        parsedResult.results.push(...batch.results);
        parsedResult.parsed += batch.parsed;
        progress("parsing", `正在整理该文件夹字体：${Math.min(start + 32, inputs.length)}/${inputs.length}。`, { totalFiles: rows.length, parsedFiles: parsedResult.parsed, fromCache });
        await deps.delayToEventLoop();
      }
      guard();
      const changedEntryMap = new Map<string, FontScanCacheEntry>();
      for (const result of parsedResult.results) {
        if (result.error) { payload.errors!.push({ path: result.file, message: result.error }); continue; }
        const entry = context.cache.entries[result.key];
        if (!entry || !indexRuntime.fontIndexEntryChanged(before[result.key], entry)) continue;
        changedEntryMap.set(result.key, entry);
        if (result.font) payload.upserts.push(result.font);
        else {
          skippedBad++;
          if (before[result.key]?.status === "ok") {
            payload.deletes.push(indexRuntime.fontIndexDeleteRecord(resolvedRoot, result.key, before[result.key]));
            repairDeletes++;
          }
        }
      }
      const deletedKeys: string[] = [];
      for (const [key, entry] of Object.entries(context.cache.entries)) {
        if (payload.errors?.length) break;
        if (!indexRuntime.cacheKeyInsideDirectory(key, relativeTargetDir) || seen.has(key)) continue;
        deletedKeys.push(key);
        payload.deletes.push(indexRuntime.fontIndexDeleteRecord(resolvedRoot, key, entry));
        delete context.cache.entries[key];
      }
      const changedEntries = [...changedEntryMap.entries()];
      progress("writing", `正在写入索引变更：新增/更新 ${changedEntries.length} 个，文件缺失 ${deletedKeys.length} 个。`, { totalFiles: rows.length, parsedFiles: parsedResult.parsed, fromCache, skippedBad, workerCount: 0 });
      if (changedEntries.length || deletedKeys.length) {
        guard();
        if (deps.isRootIndexDbPath(storage.cachePath)) {
          await deps.saveRootIndexSqliteChanges(storage.cachePath, resolvedRoot, storage.storage, changedEntries, deletedKeys, guard);
        } else {
          await deps.saveScanCacheFile(storage.cachePath, { version: deps.fontScanCacheVersion, entries: context.cache.entries }, resolvedRoot, storage.storage);
          guard();
          await deps.writeRootCacheManifest(storage.cacheDir, resolvedRoot, storage.storage, Object.keys(context.cache.entries).length, storage.cachePath);
        }
        // A successful source receipt remains committed even if cancellation now
        // prevents projection. The next explicit refresh repairs that projection.
        for (const [key, entry] of changedEntries) sourceCache.entries[key] = entry;
        for (const key of deletedKeys) delete sourceCache.entries[key];
        guard();
      }
      if (!payload.errors?.length) { await indexRuntime.saveRootDirectorySignatures(context); guard(); }
      deps.invalidateSharedFontRuntimeCaches();
      deps.appendStartupLog(`manual folder refresh index applied: total=${rows.length}, parsed=${parsedResult.parsed}, cache=${fromCache}, addedFiles=${addedFiles}, changedFiles=${changedFiles}, metadataRepairs=${metadataRepairs}, sourceDeletes=${deletedKeys.length}, projectionDeletes=${repairDeletes}, cacheMissReasons=${JSON.stringify(reasons)}, upserts=${payload.upserts.length}, deletes=${payload.deletes.length}, durationMs=${Date.now() - startedAt}`);
      return { payload, totalFiles: rows.length, parsed: parsedResult.parsed, fromCache, skippedBad, durationMs: Date.now() - startedAt, workerCount: 0, sourceDeletes: deletedKeys.length, projectionDeletes: repairDeletes, addedFiles, changedFiles, metadataRepairs };
    } catch (error) {
      const failure = error as SharedIoProcessError | undefined;
      if (failure?.sharedIo === true && failure.closed) { try { await failure.closed; } catch { /* Preserve the operation failure. */ } }
      throw error;
    }
  }

  return { applyManualFolderRefreshToIndex };
}

export type ManualFolderIndexApplyRuntime = ReturnType<typeof createManualFolderIndexApplyRuntime>;
