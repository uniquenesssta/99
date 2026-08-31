import { promises as fsp } from "node:fs";
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
        const db = openStableSqliteDb(item.path, `${item.label}:manual-refresh`);
        try {
          item.init(db, resolvedRoot);
          sqliteQuickCheck(db, `${item.label}:manual-refresh`, item.path, true);
        } finally {
          closeSqliteDb(db);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await quarantineSqliteFiles(
          item.path,
          `${item.label}-manual-refresh-${sha1(resolvedRoot).slice(0, 10)}`,
          message,
          join(rootCacheDir(resolvedRoot), "corrupt"),
        ).catch((quarantineError) => {
          appendStartupLog(
            `manual refresh ${item.label} quarantine skipped: ${item.path} ${recoveryMessage(quarantineError)}`,
          );
        });
        const db = openStableSqliteDb(
          item.path,
          `${item.label}:manual-refresh-recreated`,
        );
        try {
          item.init(db, resolvedRoot);
          sqliteQuickCheck(
            db,
            `${item.label}:manual-refresh-recreated`,
            item.path,
            true,
          );
        } finally {
          closeSqliteDb(db);
        }
        appendStartupLog(
          `manual refresh ${item.label} repaired: root=${resolvedRoot}, reason=${message}`,
        );
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

      const db = await openRootIndexDb(dbPath, resolvedRoot, "root", true);
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
        await writeRootCacheManifest(
          cacheDir,
          resolvedRoot,
          "root",
          Number(row?.count || 0),
          dbPath,
        );
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
      const message = error instanceof Error ? error.message : String(error);
      dbPath = dbPath || defaultDbPath;
      await quarantineSqliteFiles(
        dbPath,
        `root-index-manual-refresh-${sha1(resolvedRoot).slice(0, 10)}`,
        message,
        join(cacheDir, "corrupt"),
      ).catch((quarantineError) => {
        appendStartupLog(
          `manual refresh index cache quarantine skipped: ${dbPath} ${recoveryMessage(quarantineError)}`,
        );
      });

      const db = await openRootIndexDb(defaultDbPath, resolvedRoot, "root", true);
      try {
        sqliteQuickCheck(
          db,
          "root-index-manual-refresh-recreated",
          defaultDbPath,
          true,
        );
        await writeRootCacheManifest(
          cacheDir,
          resolvedRoot,
          "root",
          0,
          defaultDbPath,
        );
      } finally {
        closeSqliteDb(db);
      }

      appendStartupLog(
        `manual refresh index cache repaired: root=${resolvedRoot}, reason=${message}`,
      );
      return {
        ...cacheRepairStatus(
          "index",
          defaultDbPath,
          true,
          true,
          `索引缓存异常，已隔离旧文件并覆盖重建：${message}`,
        ),
        rebuildRequired: true,
      };
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
      const message = error instanceof Error ? error.message : String(error);
      await quarantineSqliteFiles(
        previewDbPath,
        `root-preview-manual-refresh-${sha1(resolvedRoot).slice(0, 10)}`,
        message,
        join(previewCacheDir, "corrupt"),
      ).catch((quarantineError) => {
        appendStartupLog(
          `manual refresh preview cache quarantine skipped: ${previewDbPath} ${recoveryMessage(quarantineError)}`,
        );
      });

      await fsp.mkdir(previewImageDir, { recursive: true });
      await fsp.mkdir(dirname(previewDbPath), { recursive: true });
      const db = openStableSqliteDb(
        previewDbPath,
        "preview:manual-refresh-recreated",
      );
      try {
        initializePreviewDb(db);
        sqliteQuickCheck(
          db,
          "preview:manual-refresh-recreated",
          previewDbPath,
          true,
        );
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

      appendStartupLog(
        `manual refresh preview cache repaired: root=${resolvedRoot}, reason=${message}`,
      );
      return cacheRepairStatus(
        "preview",
        previewDbPath,
        true,
        true,
        `预览缓存异常，已隔离旧文件并重新创建：${message}`,
      );
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
