import type { FolderNode,LibraryShell,LibraryState } from "../../../shared/types";
import { parseSqliteJson,setSqliteMeta } from "../../db/sqliteHelpers";
import { defaultLibrary,normalizeLoadedLibrary } from "../libraryState";
import { sanitizeWatchedFoldersForStorage } from "./libraryFolderStorageRuntime";
import { normalizeNativePathText } from "../../path/pathCanonicalizer";
import type { SqliteDb } from "./libraryRuntimeTypes";

export function saveLibraryToSqlite(db: SqliteDb, state: LibraryState): void {
  const normalized = normalizeLoadedLibrary({
    ...state,
    fonts: {},
    fontFolderIds: {},
  });
  const now = new Date().toISOString();
  const saveTx = db.transaction(() => {
    db.exec(
      "DELETE FROM app_state; DELETE FROM folders; DELETE FROM folder_nodes; DELETE FROM collections; DELETE FROM tags;",
    );

    const insertState = db.prepare(
      "INSERT INTO app_state (key, value) VALUES (?, ?)",
    );
    insertState.run("previewText", normalized.previewText);
    insertState.run("previewMode", normalized.previewMode);
    insertState.run("folderAliases", JSON.stringify(normalized.folderAliases || {}));
    insertState.run(
      "localCollections",
      JSON.stringify(normalized.localCollections || []),
    );
    insertState.run("localTags", JSON.stringify(normalized.localTags || []));

    const insertFolder = db.prepare(
      "INSERT INTO folders (path, sort_order) VALUES (?, ?)",
    );
    sanitizeWatchedFoldersForStorage(normalized.folders || []).forEach(
      (folder, index) => insertFolder.run(folder, index),
    );

    const insertFolderNode = db.prepare(
      "INSERT INTO folder_nodes (id, json, sort_order) VALUES (?, ?, ?)",
    );
    (normalized.folderNodes || []).forEach((node, index) =>
      insertFolderNode.run(node.id, JSON.stringify(node), index),
    );

    const insertCollection = db.prepare(
      "INSERT INTO collections (id, json, sort_order) VALUES (?, ?, ?)",
    );
    (normalized.collections || []).forEach((collection, index) =>
      insertCollection.run(collection.id, JSON.stringify(collection), index),
    );

    const insertTag = db.prepare("INSERT INTO tags (name, sort_order) VALUES (?, ?)");
    (normalized.tags || []).forEach((tag, index) => insertTag.run(tag, index));

    setSqliteMeta(db, "updatedAt", now);
    setSqliteMeta(db, "settingsOnly", "1");
    setSqliteMeta(db, "cacheArchitecture", "v1-clean-shared-root");
  });
  saveTx();
}

export function loadLibraryFromSqlite(db: SqliteDb): LibraryState {
  const shell = loadLibraryShellFromSqlite(db);
  return normalizeLoadedLibrary({
    ...shell,
    fonts: {},
    fontFolderIds: {},
  });
}

export function loadLibraryShellFromSqlite(db: SqliteDb): LibraryShell {
  const stateRows = db
    .prepare("SELECT key, value FROM app_state")
    .all() as Array<{ key: string; value: string }>;
  const appState = Object.fromEntries(
    stateRows.map((row) => [row.key, row.value]),
  ) as Record<string, string>;
  const folders = (
    db.prepare("SELECT path FROM folders ORDER BY sort_order").all() as Array<{
      path: string;
    }>
  ).map((row) => row.path);
  const normalizedFolders = sanitizeWatchedFoldersForStorage(folders);
  const folderNodes = (
    db.prepare("SELECT json FROM folder_nodes ORDER BY sort_order").all() as Array<{
      json: string;
    }>
  ).map((row) => parseSqliteJson<FolderNode>(row.json, {} as FolderNode))
    .map((node) => ({
      ...node,
      id: node.id?.startsWith('vf_') ? node.id : normalizeNativePathText(node.id),
      parentId: node.parentId?.startsWith('vf_') ? node.parentId : normalizeNativePathText(node.parentId),
      rootPath: node.rootPath?.startsWith('vf_') ? node.rootPath : normalizeNativePathText(node.rootPath),
    }))
    .filter((node) => !!node.id);
  const collections = (
    db.prepare("SELECT json FROM collections ORDER BY sort_order").all() as Array<{
      json: string;
    }>
  ).map((row) =>
    parseSqliteJson(row.json, {} as LibraryState["collections"][number]),
  );
  const tags = (
    db.prepare("SELECT name FROM tags ORDER BY sort_order").all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);

  return {
    folders: normalizedFolders,
    folderAliases: parseSqliteJson<Record<string, string>>(
      appState.folderAliases,
      {},
    ),
    folderNodes,
    fontFolderIds: {},
    fonts: {},
    collections,
    tags,
    localCollections: parseSqliteJson<LibraryState["localCollections"]>(
      appState.localCollections,
      [],
    ),
    localTags: parseSqliteJson<LibraryState["localTags"]>(
      appState.localTags,
      [],
    ),
    previewText: appState.previewText || defaultLibrary().previewText,
    previewMode:
      (appState.previewMode as LibraryState["previewMode"]) || "waterfall",
    totalFonts: 0,
  };
}
