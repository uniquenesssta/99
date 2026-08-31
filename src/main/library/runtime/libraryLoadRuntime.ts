import type { FontItem,LibraryShell,LibraryState } from "../../../shared/types";
import { defaultLibrary,normalizeLoadedLibrary } from "../libraryState";
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
    try {
      const db = await openLibraryDb();
      const base = loadLibraryFromSqlite(db);
      const fonts = await loadSharedFontsForFolders(base.folders || []);
      const hydratedFonts = await hydrateLocalTagsForFonts(fonts);
      const fontMap = Object.fromEntries(
        hydratedFonts.map((font) => [font.id, font]),
      ) as Record<string, FontItem>;
      return normalizeLoadedLibrary({
        ...base,
        fonts: fontMap,
        fontFolderIds: {},
      });
    } catch (error) {
      appendStartupLog(
        `load clean shared library failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return defaultLibrary();
    }
  }

  async function loadLibraryShell(): Promise<LibraryShell> {
    try {
      const db = await openLibraryDb();
      const shell = loadLibraryShellFromSqlite(db);
      const totalFonts = await countSharedFontsForFolders(shell.folders || []);
      return { ...shell, totalFonts };
    } catch (error) {
      appendStartupLog(
        `load clean shared library shell failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ...defaultLibrary(),
        fontFolderIds: {},
        totalFonts: 0,
      } as LibraryShell;
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
