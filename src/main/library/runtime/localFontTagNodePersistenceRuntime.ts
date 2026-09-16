import type { FontItem, FontTagBatchItem } from "../../../shared/types";
import type { SqliteDb } from "./libraryRuntimeTypes";
import { localTagFontIdAliases, localTagFontPath, localTagFontStorageId } from "./localFontTagIdentityRuntime";

function deleteLocalTagForFontIdentity(
  db: SqliteDb,
  item: Pick<FontItem, "id" | "sourceId" | "path">,
): void {
  const aliases = localTagFontIdAliases(item);
  const fontPath = localTagFontPath(item);
  if (aliases.length) {
    db.prepare(`DELETE FROM local_font_tags WHERE font_id IN (${aliases.map(() => "?").join(",")})`).run(...aliases);
  }
  if (fontPath) db.prepare("DELETE FROM local_font_tags WHERE font_path = ?").run(fontPath);
}

export function cleanKnownTagNames(tagNamesInput: string[]): string[] {
  return Array.from(
    new Set(
      (tagNamesInput || [])
        .map((tag) => String(tag || "").trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function readLocalTagCatalog(db: SqliteDb): string[] {
  const row = db
    .prepare("SELECT value FROM app_state WHERE key = ?")
    .get("localTags") as { value?: string } | undefined;
  if (!row?.value) return [];
  try {
    const parsed = JSON.parse(row.value);
    return cleanKnownTagNames(Array.isArray(parsed) ? parsed : []);
  } catch {
    return [];
  }
}

function readBoundLocalTags(db: SqliteDb): string[] {
  const rows = db
    .prepare("SELECT DISTINCT tag_name FROM local_font_tags WHERE TRIM(COALESCE(tag_name, '')) <> '' ORDER BY tag_name")
    .all() as Array<{ tag_name: string }>;
  return cleanKnownTagNames(rows.map((row) => row.tag_name));
}

function mergeKnownLocalTags(...sources: string[][]): string[] {
  return cleanKnownTagNames(sources.flat());
}

function readPersistedLocalTags(db: SqliteDb): string[] {
  return mergeKnownLocalTags(readLocalTagCatalog(db), readBoundLocalTags(db));
}

function retainedEmptyLocalTags(previousBound: string[], nextBound: string[], knownTags: string[]): string[] {
  const nextBoundSet = new Set(cleanKnownTagNames(nextBound));
  const knownSet = new Set(cleanKnownTagNames(knownTags));
  return cleanKnownTagNames(previousBound).filter((tag) => !nextBoundSet.has(tag) && knownSet.has(tag));
}

function saveKnownLocalTags(db: SqliteDb, tagNames: string[]): void {
  db.prepare("INSERT OR REPLACE INTO app_state (key, value) VALUES (?, ?)").run(
    "localTags",
    JSON.stringify(cleanKnownTagNames(tagNames)),
  );
}

export function cleanLocalTagNames(tagNamesInput: string[]): string[] {
  return Array.from(
    new Set(
      (tagNamesInput || [])
        .map((tag) => String(tag || "").trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function insertLocalTagsForFont(
  db: SqliteDb,
  item: FontItem,
  tagNames: string[],
  updatedAt: string,
): void {
  const aliases = localTagFontIdAliases(item);
  const storageId = localTagFontStorageId(item);
  if (storageId && !aliases.includes(storageId)) aliases.push(storageId);
  const cleanAliases = Array.from(new Set(aliases.map((id) => String(id || "").trim()).filter(Boolean)));
  if (!cleanAliases.length) return;
  const fontPath = localTagFontPath(item);
  const insert = db.prepare(
    "INSERT OR REPLACE INTO local_font_tags (font_id, font_path, tag_name, updated_at) VALUES (?, ?, ?, ?)",
  );
  for (const id of cleanAliases) {
    for (const tag of tagNames) insert.run(id, fontPath, tag, updatedAt);
  }
}

export function createLocalFontTagNodePersistenceRuntime(openLibraryDb: () => Promise<SqliteDb>) {
  async function localTagsByFontIds(ids: string[]) {
    const db = await openLibraryDb();
    const result: Record<string, string[]> = {};
    const chunkSize = 500;
    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize);
      const rows = db
        .prepare(
          `SELECT font_id, tag_name FROM local_font_tags WHERE font_id IN (${chunk.map(() => "?").join(",")}) ORDER BY tag_name`,
        )
        .all(...chunk) as Array<{ font_id: string; tag_name: string }>;
      for (const row of rows) {
        if (!result[row.font_id]) result[row.font_id] = [];
        result[row.font_id].push(row.tag_name);
      }
    }
    return result;
  }

  async function hydrateLocalTagsForFonts(items: FontItem[]) {
    const aliasToRuntimeIds = new Map<string, Set<string>>();
    const pathToRuntimeIds = new Map<string, Set<string>>();
    const ids: string[] = [];
    const paths: string[] = [];
    for (const item of items) {
      if (!item?.id) continue;
      const runtimeId = item.id;
      for (const id of localTagFontIdAliases(item)) {
        if (!aliasToRuntimeIds.has(id)) {
          ids.push(id);
          aliasToRuntimeIds.set(id, new Set());
        }
        aliasToRuntimeIds.get(id)!.add(runtimeId);
      }
      const fontPath = localTagFontPath(item);
      if (fontPath) {
        if (!pathToRuntimeIds.has(fontPath)) {
          paths.push(fontPath);
          pathToRuntimeIds.set(fontPath, new Set());
        }
        pathToRuntimeIds.get(fontPath)!.add(runtimeId);
      }
    }

    const tagMap: Record<string, string[]> = {};
    const addTag = (runtimeId: string, tagName: string): void => {
      if (!runtimeId || !tagName) return;
      if (!tagMap[runtimeId]) tagMap[runtimeId] = [];
      if (!tagMap[runtimeId].includes(tagName)) tagMap[runtimeId].push(tagName);
    };

    const db = await openLibraryDb();
    const chunkSize = 500;
    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = ids.slice(index, index + chunkSize);
      const rows = db
        .prepare(
          `SELECT font_id, tag_name FROM local_font_tags WHERE font_id IN (${chunk.map(() => "?").join(",")}) ORDER BY tag_name`,
        )
        .all(...chunk) as Array<{ font_id: string; tag_name: string }>;
      for (const row of rows) {
        for (const runtimeId of aliasToRuntimeIds.get(row.font_id) || [])
          addTag(runtimeId, row.tag_name);
      }
    }
    for (let index = 0; index < paths.length; index += chunkSize) {
      const chunk = paths.slice(index, index + chunkSize);
      const rows = db
        .prepare(
          `SELECT font_path, tag_name FROM local_font_tags WHERE font_path IN (${chunk.map(() => "?").join(",")}) ORDER BY tag_name`,
        )
        .all(...chunk) as Array<{ font_path: string; tag_name: string }>;
      for (const row of rows) {
        for (const runtimeId of pathToRuntimeIds.get(row.font_path) || [])
          addTag(runtimeId, row.tag_name);
      }
    }

    for (const tags of Object.values(tagMap)) tags.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    return items.map((item) => ({
      ...item,
      localTagNames: tagMap[item.id] || [],
    }));
  }

  async function openWriter() {
    const db = await openLibraryDb();
    function setLocalFontTags(item: FontItem, tagNames: string[], now: string) {
      const previousKnownTags = readPersistedLocalTags(db);
      const previousBoundTags = readBoundLocalTags(db);
      let knownTags: string[] = [];
      let retainedEmptyTags: string[] = [];
      const tx = db.transaction(() => {
        deleteLocalTagForFontIdentity(db, item);
        insertLocalTagsForFont(db, item, tagNames, now);
        const nextBoundTags = readBoundLocalTags(db);
        knownTags = mergeKnownLocalTags(previousKnownTags, nextBoundTags, cleanLocalTagNames(tagNames));
        retainedEmptyTags = retainedEmptyLocalTags(previousBoundTags, nextBoundTags, knownTags);
        saveKnownLocalTags(db, knownTags);
      });
      tx();
      return { previousKnownTags, knownTags, retainedEmptyTags };
    }

    function setLocalFontTagsBatch(items: FontTagBatchItem[], now: string) {
      const previousKnownTags = readPersistedLocalTags(db);
      const previousBoundTags = readBoundLocalTags(db);
      const requestedKnownTags = cleanKnownTagNames(items.flatMap((entry) => entry.tagNames || []));
      const updatedIds: string[] = [];
      const failed: Array<{ id: string; fileName: string; message: string }> = [];

      let knownTags: string[] = [];
      let retainedEmptyTags: string[] = [];
      try {
        const tx = db.transaction(() => {
          for (const entry of items) {
            const tagNames = cleanLocalTagNames(entry.tagNames || []);
            deleteLocalTagForFontIdentity(db, entry.item);
            insertLocalTagsForFont(db, entry.item, tagNames, now);
            updatedIds.push(entry.item.id);
          }

          const nextBoundTags = readBoundLocalTags(db);
          knownTags = mergeKnownLocalTags(previousKnownTags, nextBoundTags, requestedKnownTags);
          retainedEmptyTags = retainedEmptyLocalTags(previousBoundTags, nextBoundTags, knownTags);
          saveKnownLocalTags(db, knownTags);
        });

        tx();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const entry of items) {
          failed.push({
            id: entry.item.id,
            fileName: entry.item.fileName || entry.item.id,
            message,
          });
        }
        updatedIds.length = 0;
        knownTags = previousKnownTags;
      }

      return { updatedIds, failed, previousKnownTags, knownTags, retainedEmptyTags };
    }

    function deleteLocalFontTag(tagName: string) {
      const previousKnownTags = readPersistedLocalTags(db);
      const updatedIds: string[] = [];
      let knownTags: string[] = [];
      try {
        const rows = db
          .prepare("SELECT DISTINCT font_id, font_path FROM local_font_tags WHERE tag_name = ?")
          .all(tagName) as Array<{ font_id?: string; font_path?: string }>;

        const tx = db.transaction(() => {
          db.prepare("DELETE FROM local_font_tags WHERE tag_name = ?").run(tagName);
          knownTags = previousKnownTags.filter((tag) => tag !== tagName);
          saveKnownLocalTags(db, knownTags);
        });
        tx();
        updatedIds.push(...Array.from(new Set(rows.map((item) => item.font_id || item.font_path || '').filter(Boolean))));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false as const, message };
      }
      return { ok: true as const, updatedIds, previousKnownTags, knownTags };
    }

    return { setLocalFontTags, setLocalFontTagsBatch, deleteLocalFontTag };
  }

  return { localTagsByFontIds, hydrateLocalTagsForFonts, openWriter };
}
