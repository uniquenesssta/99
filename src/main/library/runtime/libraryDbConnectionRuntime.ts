import { promises as fsp } from "node:fs";
import { dirname } from "node:path";
import type { LibraryRuntimeOptions,SqliteDb } from "./libraryRuntimeTypes";
import { initializeLibraryDb } from "./librarySchemaRuntime";

export function createLibraryDbConnectionRuntime(options: Pick<
  LibraryRuntimeOptions,
  "librarySqlitePath" | "openRecoverableApplicationSqliteDb" | "closeSqliteDb"
>) {
  const { librarySqlitePath, openRecoverableApplicationSqliteDb, closeSqliteDb } = options;
  let libraryDb: SqliteDb | null = null;
  let libraryDbOpening: Promise<SqliteDb> | null = null;

  function isSqliteDbOpen(db: SqliteDb | null): db is SqliteDb {
    if (!db) return false;
    return (db as any).open !== false;
  }

  async function openLibraryDb(): Promise<SqliteDb> {
    if (isSqliteDbOpen(libraryDb)) return libraryDb;
    if (libraryDb) libraryDb = null;
    if (libraryDbOpening) return libraryDbOpening;

    libraryDbOpening = (async () => {
      await fsp.mkdir(dirname(librarySqlitePath()), { recursive: true });
      const db = await openRecoverableApplicationSqliteDb(
        librarySqlitePath(),
        "library",
      );
      try {
        initializeLibraryDb(db);
        libraryDb = db;
        return db;
      } catch (error) {
        closeSqliteDb(db);
        throw error;
      }
    })();

    try {
      return await libraryDbOpening;
    } finally {
      libraryDbOpening = null;
    }
  }

  function getOpenLibraryDb(): SqliteDb | null {
    if (isSqliteDbOpen(libraryDb)) return libraryDb;
    if (libraryDb) libraryDb = null;
    return null;
  }

  function closeLibraryDb(): void {
    closeSqliteDb(libraryDb);
    libraryDb = null;
    libraryDbOpening = null;
  }

  return {
    openLibraryDb,
    getOpenLibraryDb,
    closeLibraryDb,
  };
}
