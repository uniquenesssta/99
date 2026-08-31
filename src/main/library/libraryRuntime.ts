import { defaultLibrary,normalizeLoadedLibrary } from "./libraryState";
import { createLibraryDbConnectionRuntime } from "./runtime/libraryDbConnectionRuntime";
import { createLibraryLoadRuntime } from "./runtime/libraryLoadRuntime";
import {
loadLibraryFromSqlite,
loadLibraryShellFromSqlite,
saveLibraryToSqlite,
} from "./runtime/libraryPersistenceRuntime";
import type { LibraryRuntimeOptions } from "./runtime/libraryRuntimeTypes";
import {
ensureStructuredFontsSchema as ensureStructuredFontsSchemaBase,
initializeLibraryDb,
migrateLegacyFontJsonRows as migrateLegacyFontJsonRowsBase,
sqliteHasLibraryData,
} from "./runtime/librarySchemaRuntime";
import { createLocalFontTagsRuntime } from "./runtime/localFontTagsRuntime";

export function createLibraryRuntime(options: LibraryRuntimeOptions) {
  const {
    ensureSqliteColumn,
    loadSharedFontsForFolders,
    countSharedFontsForFolders,
    invalidateSharedFontRuntimeCaches,
    appendStartupLog,
  } = options;

  const dbConnectionRuntime = createLibraryDbConnectionRuntime(options);
  const { openLibraryDb, getOpenLibraryDb, closeLibraryDb } = dbConnectionRuntime;

  const localFontTagsRuntime = createLocalFontTagsRuntime({
    openLibraryDb,
    librarySqlitePath: options.librarySqlitePath,
    appendStartupLog,
    runRustLocalTagsRead: options.runRustLocalTagsRead,
    runRustLocalTagsSet: options.runRustLocalTagsSet,
    runRustLocalTagsDeleteTag: options.runRustLocalTagsDeleteTag,
    onLocalTagsMutationStateSignal: options.onLocalTagsMutationStateSignal,
  });
  const {
    localTagsByFontIds,
    hydrateLocalTagsForFonts,
    setLocalFontTags,
    setLocalFontTagsBatch,
    deleteLocalFontTag,
  } = localFontTagsRuntime;

  const libraryLoadRuntime = createLibraryLoadRuntime({
    openLibraryDb,
    loadSharedFontsForFolders,
    countSharedFontsForFolders,
    hydrateLocalTagsForFonts,
    invalidateSharedFontRuntimeCaches,
    appendStartupLog,
  });
  const {
    migrateLibraryJsonToSqliteIfNeeded,
    loadLibrary,
    loadLibraryShell,
    saveLibrary,
  } = libraryLoadRuntime;

  function ensureStructuredFontsSchema(db: any): void {
    ensureStructuredFontsSchemaBase(db, ensureSqliteColumn);
  }

  function migrateLegacyFontJsonRows(db: any): void {
    migrateLegacyFontJsonRowsBase(db, appendStartupLog);
  }

  return {
    defaultLibrary,
    normalizeLoadedLibrary,
    ensureStructuredFontsSchema,
    migrateLegacyFontJsonRows,
    initializeLibraryDb,
    sqliteHasLibraryData,
    saveLibraryToSqlite,
    loadLibraryFromSqlite,
    loadLibraryShellFromSqlite,
    migrateLibraryJsonToSqliteIfNeeded,
    openLibraryDb,
    getOpenLibraryDb,
    closeLibraryDb,
    localTagsByFontIds,
    hydrateLocalTagsForFonts,
    setLocalFontTags,
    setLocalFontTagsBatch,
    deleteLocalFontTag,
    loadLibrary,
    loadLibraryShell,
    saveLibrary,
  };
}
