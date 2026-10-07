import type { FontItem,LibraryShell,LibraryState } from "../../../shared/types";
import { normalizeLoadedLibrary } from "../libraryState";
import { loadLibraryFromSqlite,loadLibraryShellFromSqlite,saveLibraryToSqlite } from "./libraryPersistenceRuntime";
import type { LibraryRuntimeOptions,SqliteDb } from "./libraryRuntimeTypes";

export function createLibraryLoadRuntime(options: {
  openLibraryDb: () => Promise<SqliteDb>;
  loadSharedFontsForFolders: LibraryRuntimeOptions["loadSharedFontsForFolders"];
  countSharedFontsForFolders: LibraryRuntimeOptions["countSharedFontsForFolders"];
  hydrateLocalTagsForFonts: (items: FontItem[]) => Promise<FontItem[]>;
  invalidateSharedFontRuntimeCaches: LibraryRuntimeOptions["invalidateSharedFontRuntimeCaches"];
  appendStartupLog: LibraryRuntimeOptions["appendStartupLog"];
}) {
  const {
    openLibraryDb,
    loadSharedFontsForFolders,
    countSharedFontsForFolders,
    hydrateLocalTagsForFonts,
    invalidateSharedFontRuntimeCaches,
    appendStartupLog,
  } = options;

  async function migrateLibraryJsonToSqliteIfNeeded(_db: SqliteDb): Promise<void> {
    // v2.0 stable architecture: legacy library.json/local SQLite font records are not imported.
    appendStartupLog(
      "v2.0 stable architecture: legacy library import skipped by design",
    );
  }

  async function loadLibrary(): Promise<LibraryState> {
    const db = await openLibraryDb();
    const base = loadLibraryFromSqlite(db);
    try {
      const fonts = await loadSharedFontsForFolders(base.folders || []);
      const hydratedFonts = await hydrateLocalTagsForFonts(fonts);
      return normalizeLoadedLibrary({ ...base, fonts: Object.fromEntries(hydratedFonts.map(font => [font.id, font])), fontFolderIds: {} });
    } catch (error) {
      appendStartupLog(`load shared font population deferred; user state retained: ${String(error)}`);
      return normalizeLoadedLibrary(base);
    }
  }

  async function loadLibraryShell(): Promise<LibraryShell> {
    // An unreadable application DB must not produce a default shell which could
    // subsequently be saved over the user's folders, favorites or tags.
    const db = await openLibraryDb();
    const shell = loadLibraryShellFromSqlite(db);
    try {
      const totalFonts = await countSharedFontsForFolders(shell.folders || []);
      return { ...shell, totalFonts };
    } catch (error) {
      appendStartupLog(`load shared font count deferred; user shell retained: ${String(error)}`);
      return shell;
    }
  }

  async function saveLibrary(state: LibraryState): Promise<boolean> {
    const db = await openLibraryDb();
    saveLibraryToSqlite(db, state);
    invalidateSharedFontRuntimeCaches();
    return true;
  }

  return {
    migrateLibraryJsonToSqliteIfNeeded,
    loadLibrary,
    loadLibraryShell,
    saveLibrary,
  };
}
