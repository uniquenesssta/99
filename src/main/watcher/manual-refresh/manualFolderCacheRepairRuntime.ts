import { isRecoverableDerivedSqliteError } from '../../db/sqliteRecoveryPolicy'
import { ROOT_INDEX_DB_SCHEMA_VERSION, PREVIEW_SQLITE_SCHEMA_VERSION } from '../../cache/constants'
import { sharedIoResourceKeys } from '../../rust-core/rustSharedIoCommandRuntime'
import { executeSharedFile, sharedFileSystem as fsp } from '../../path/sharedFileSystemRuntime'
import { dirname,join,resolve } from "node:path";
import type { FolderCacheRepairStatus } from "../../../shared/types";
import type { ManualFolderRefreshDeps } from "./manualFolderRefreshTypes";

export type RootIndexCacheRepairStatus = FolderCacheRepairStatus & {
  rebuildRequired: boolean;
};

export function createManualFolderCacheRepairRuntime(deps: ManualFolderRefreshDeps) {
  const {
    appendStartupLog,
    rootIndexDbDir,
    rootCacheLockDir,
    rootCacheDir,
    rootIndexDbPath,
    resolveActiveRootIndexDbPath,
    openRootIndexDb,
    closeSqliteDb,
    sqliteQuickCheck,
    sqliteTableExists,
    quarantineSqliteFiles,
    recoveryMessage,
    sha1,
    hideDirectoryOnWindows,
    exists,
    initializeRootEventsDb,
    initializeRootHashDb,
    initializeRootMetricsDb,
    rootEventsDbPath,
    rootHashDbPath,
    rootMetricsDbPath,
    openStableSqliteDb,
    initializePreviewDb,
    writeRootPreviewCacheManifest,
    rootPreviewCacheDir,
    rootPreviewImageDir,
    rootPreviewDbPath,
    writeRootCacheManifest,
  } = deps;

  function cacheRepairStatus(
    cache: "index" | "preview",
    pathValue: string,
    ok: boolean,
    repaired: boolean,
    message: string,
  ): FolderCacheRepairStatus {
    return { cache, path: pathValue, ok, repaired, message };
  }

  async function ensureRootArchitectureDatabasesWithRepair(
    rootPath: string,
  ): Promise<void> {
    const resolvedRoot = resolve(rootPath);
    await fsp.mkdir(rootIndexDbDir(resolvedRoot), { recursive: true });

    const databases: Array<{
      path: string;
      label: string;
      init: (db: any, rootPath: string) => void;
    }> = [
      {
        path: rootEventsDbPath(resolvedRoot),
        label: "root-events",
        init: initializeRootEventsDb,
      },
      {
        path: rootHashDbPath(resolvedRoot),
        label: "root-hash",
        init: initializeRootHashDb,
      },
      {
        path: rootMetricsDbPath(resolvedRoot),
        label: "root-metrics",
        init: initializeRootMetricsDb,
      },
    ];

    for (const item of databases) {
      try {
        if ((await sharedIoResourceKeys([item.path])).length) {
          await executeSharedFile({ operation:'repairRootDatabase', path:item.path, rootPath:resolvedRoot, kind:item.label.slice(5) as 'events' | 'hash' | 'metrics', repairCorrupt:false, dest:join(rootCacheDir(resolvedRoot),'corrupt') });
          continue;
        }
        const db = openStableSqliteDb(item.path, `${item.label}:manual-refresh`);
        try {
          item.init(db, resolvedRoot);
          sqliteQuickCheck(db, `${item.label}:manual-refresh`, item.path, true);
        } finally {
          closeSqliteDb(db);
        }
      } catch (error) {
        appendStartupLog(`manual refresh ${item.label} unavailable; original retained: ${item.path} ${recoveryMessage(error)}`);
        throw error;
      }
    }
  }

  async function repairRootIndexCacheIfNeeded(
    rootPath: string,
  ): Promise<RootIndexCacheRepairStatus> {
    const resolvedRoot = resolve(rootPath);
    const cacheDir = rootCacheDir(resolvedRoot);
    const defaultDbPath = rootIndexDbPath(resolvedRoot);
    let dbPath = defaultDbPath;
    let existedBefore = false;

    try {
      await fsp.mkdir(rootIndexDbDir(resolvedRoot), { recursive: true });
      await fsp.mkdir(rootCacheLockDir(resolvedRoot), { recursive: true });
      await hideDirectoryOnWindows(cacheDir);
      await ensureRootArchitectureDatabasesWithRepair(resolvedRoot);
      dbPath = await resolveActiveRootIndexDbPath(cacheDir, defaultDbPath);
      existedBefore = await exists(dbPath);

      if (!existedBefore) return { ...cacheRepairStatus('index', dbPath, true, false, '索引缺失，将完整扫描后建立新快照。'), rebuildRequired: true };
      const db = await openRootIndexDb(dbPath, resolvedRoot, "root", false);
      try {
        sqliteQuickCheck(db, "root-index-manual-refresh", dbPath, true);
        if (!sqliteTableExists(db, "entries"))
          throw new Error("索引表 entries 缺失。");
        if (!sqliteTableExists(db, "meta")) throw new Error("索引表 meta 缺失。");
        const row = db
          .prepare(
            "SELECT COUNT(*) AS count FROM entries WHERE COALESCE(is_deleted, 0) = 0 AND status <> 'deleted'",
          )
          .get() as { count?: number } | undefined;
        const versions = db.prepare("SELECT key,value FROM meta WHERE key IN ('schemaVersion','schema_version','cacheVersion','index_version')").all() as Array<{key: string; value: string}>;
        if (versions.some(row => Number(row.value) < (row.key === 'schemaVersion' || row.key === 'schema_version' ? ROOT_INDEX_DB_SCHEMA_VERSION : deps.fontScanCacheVersion))) {
          return { ...cacheRepairStatus('index', dbPath, true, false, '旧索引将自动升级，完整新快照就绪前保留原文件。'), rebuildRequired: true };
        }
      } finally {
        closeSqliteDb(db);
      }

      const repaired = !existedBefore;
      return {
        ...cacheRepairStatus(
          "index",
          dbPath,
          true,
          repaired,
          repaired
            ? "索引缓存缺失，已创建新的 index.sqlite，随后会覆盖重建。"
            : "索引缓存正常。",
        ),
        rebuildRequired: repaired,
      };
    } catch (error) {
      if (!isRecoverableDerivedSqliteError(error)) throw error;
      const message = recoveryMessage(error);
      appendStartupLog(`manual refresh index replacement deferred until complete scan: root=${resolvedRoot}, reason=${message}`);
      return { ...cacheRepairStatus('index', dbPath, true, false, `索引需要重建，旧文件保留：${message}`), rebuildRequired: true };
    }
  }

  async function repairRootPreviewCacheIfNeeded(
    rootPath: string,
  ): Promise<FolderCacheRepairStatus> {
    const resolvedRoot = resolve(rootPath);
    const previewCacheDir = rootPreviewCacheDir(resolvedRoot);
    const previewImageDir = rootPreviewImageDir(resolvedRoot);
    const previewDbPath = rootPreviewDbPath(resolvedRoot);
    let existedBefore = false;

    try {
      await fsp.mkdir(previewImageDir, { recursive: true });
      await fsp.mkdir(dirname(previewDbPath), { recursive: true });
      await hideDirectoryOnWindows(previewCacheDir);
      existedBefore = await exists(previewDbPath);

      if ((await sharedIoResourceKeys([previewDbPath])).length) {
        const { result } = await executeSharedFile({ operation:'repairRootDatabase', kind:'preview', path:previewDbPath, rootPath:resolvedRoot,
          schemaVersion:PREVIEW_SQLITE_SCHEMA_VERSION, repairCorrupt:false, dest:join(previewCacheDir,'corrupt') });
        await writeRootPreviewCacheManifest(previewCacheDir,resolvedRoot,'root',previewDbPath,previewImageDir);
        return cacheRepairStatus('preview',previewDbPath,true,result.value.repaired === true,result.value.repaired ? '预览缓存已修复。' : '预览缓存正常。');
      }
      const db = openStableSqliteDb(previewDbPath, "preview:manual-refresh");
      try {
        initializePreviewDb(db);
        sqliteQuickCheck(db, "preview:manual-refresh", previewDbPath, true);
        await writeRootPreviewCacheManifest(
          previewCacheDir,
          resolvedRoot,
          "root",
          previewDbPath,
          previewImageDir,
        );
      } finally {
        closeSqliteDb(db);
      }

      return cacheRepairStatus(
        "preview",
        previewDbPath,
        true,
        !existedBefore,
        existedBefore
          ? "预览缓存正常。"
          : "预览缓存缺失，已创建新的 preview.sqlite。",
      );
    } catch (error) {
      const message = recoveryMessage(error);
      appendStartupLog(`manual refresh optional preview cache unavailable; original retained: ${previewDbPath} ${message}`);
      return cacheRepairStatus('preview', previewDbPath, false, false, `预览索引暂不可用，已保留原文件：${message}`);
    }
  }

  return {
    cacheRepairStatus,
    ensureRootArchitectureDatabasesWithRepair,
    repairRootIndexCacheIfNeeded,
    repairRootPreviewCacheIfNeeded,
  };
}

export type ManualFolderCacheRepairRuntime = ReturnType<typeof createManualFolderCacheRepairRuntime>;
