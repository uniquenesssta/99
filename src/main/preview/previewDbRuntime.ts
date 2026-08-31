import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import { initializePreviewDbSchema } from "./previewCacheRuntime";

export type PreviewDbRuntimeOptions = {
  previewSqliteSchemaVersion: number;
  previewSqlitePath: () => string;
  openRecoverableApplicationSqliteDb: (
    filePath: string,
    label: "preview",
  ) => Promise<any>;
  closeSqliteDb: (db: any | null | undefined) => void;
  ensureSqliteColumn: (
    db: any,
    table: string,
    column: string,
    declaration: string,
  ) => void;
  setSqliteMeta: (db: any, key: string, value: string) => void;
};

export function createPreviewDbRuntime(options: PreviewDbRuntimeOptions) {
  const {
    previewSqliteSchemaVersion,
    previewSqlitePath,
    openRecoverableApplicationSqliteDb,
    closeSqliteDb,
    ensureSqliteColumn,
    setSqliteMeta,
  } = options;

  let previewDb: any | null = null;
  let previewDbOpening: Promise<any> | null = null;

  function initializePreviewDb(db: any): void {
    initializePreviewDbSchema(db, {
      schemaVersion: previewSqliteSchemaVersion,
      ensureSqliteColumn,
      setSqliteMeta,
    });
  }

  async function openPreviewDb(): Promise<any> {
    if (previewDb) return previewDb;
    if (previewDbOpening) return previewDbOpening;

    previewDbOpening = (async () => {
      await fsp.mkdir(dirname(previewSqlitePath()), { recursive: true });
      const db = await openRecoverableApplicationSqliteDb(
        previewSqlitePath(),
        "preview",
      );
      try {
        initializePreviewDb(db);
        previewDb = db;
        return db;
      } catch (error) {
        closeSqliteDb(db);
        throw error;
      }
    })();

    try {
      return await previewDbOpening;
    } finally {
      previewDbOpening = null;
    }
  }

  function getOpenPreviewDb(): any | null {
    return previewDb;
  }

  function closePreviewDb(): void {
    closeSqliteDb(previewDb);
    previewDb = null;
    previewDbOpening = null;
  }

  function clearLocalPreviewDbHandle(): void {
    if (previewDb) {
      try {
        previewDb.prepare("DELETE FROM preview_cache").run();
      } catch {
        /* ignore */
      }
      closeSqliteDb(previewDb);
    }
    previewDb = null;
    previewDbOpening = null;
  }

  return {
    initializePreviewDb,
    openPreviewDb,
    getOpenPreviewDb,
    closePreviewDb,
    clearLocalPreviewDbHandle,
  };
}
