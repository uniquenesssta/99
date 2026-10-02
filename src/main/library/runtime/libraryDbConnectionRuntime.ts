import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import type { LibraryRuntimeOptions,SqliteDb } from "./libraryRuntimeTypes";
import { initializeLibraryDb } from "./librarySchemaRuntime";

export function createLibraryDbConnectionRuntime(options: Pick<
  LibraryRuntimeOptions,
  "librarySqlitePath" | "openRecoverableApplicationSqliteDb" | "closeSqliteDb" | "prepareLocalFontIdentity"
>) {
  const { librarySqlitePath, openRecoverableApplicationSqliteDb, closeSqliteDb } = options;
  let libraryDb: SqliteDb | null = null;
  let libraryDbOpening: Promise<SqliteDb> | null = null;
  let generation = 0;

  function isSqliteDbOpen(db: SqliteDb | null): db is SqliteDb {
    if (!db) return false;
    return (db as any).open !== false;
  }

  async function openLibraryDb(): Promise<SqliteDb> {
    // Cached handles also need preparation. Coalesce the whole operation, not
    // just the initial SQLite open, so startup callers cannot run migrations twice.
    if (libraryDbOpening) return libraryDbOpening;
    const openedGeneration = generation;
    const task = (async () => {
      let db = libraryDb;
      if (!isSqliteDbOpen(db)) {
        libraryDb = null;
        await fsp.mkdir(dirname(librarySqlitePath()), { recursive: true });
        if (openedGeneration !== generation) throw new Error("字体库连接已失效，请重试。");
        db = await openRecoverableApplicationSqliteDb(librarySqlitePath(), "library");
      }
      const preparingDb = db as SqliteDb;
      try {
        if (openedGeneration !== generation) throw new Error("字体库连接已失效，请重试。");
        if (preparingDb !== libraryDb) initializeLibraryDb(preparingDb);
        await options.prepareLocalFontIdentity?.(preparingDb);
        if (openedGeneration !== generation || !isSqliteDbOpen(preparingDb)) {
          throw new Error("字体库连接已失效，请重试。");
        }
        libraryDb = preparingDb;
        return preparingDb;
      } catch (error) {
        if (libraryDb === preparingDb) libraryDb = null;
        closeSqliteDb(preparingDb);
        throw error;
      }
    })();
    libraryDbOpening = task;
    try {
      return await task;
    } finally {
      if (libraryDbOpening === task) libraryDbOpening = null;
    }
  }

  function getOpenLibraryDb(): SqliteDb | null {
    if (isSqliteDbOpen(libraryDb)) return libraryDb;
    if (libraryDb) libraryDb = null;
    return null;
  }

  function closeLibraryDb(): void {
    generation += 1;
    // An in-flight preparation owns its handle until it settles. It will close
    // that handle and reject rather than publish it after this invalidation.
    if (!libraryDbOpening) closeSqliteDb(libraryDb);
    libraryDb = null;
  }

  return { openLibraryDb, getOpenLibraryDb, closeLibraryDb };
}
