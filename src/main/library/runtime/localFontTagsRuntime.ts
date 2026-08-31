import type {
FontItem,
FontTagBatchItem,
FontTagUpdateResult,
} from "../../../shared/types";
import {
localTagFontIdAliases,
localTagFontPath,
localTagFontStorageId,
} from "./localFontTagIdentityRuntime";
import { createTagMutationProtocolResult } from "../tagMutationProtocolResultRuntime";
import {
  logNodeStateFallbackDisabled,
  logNodeStateFallbackUsed,
  nodeStateFallbackCompatibilityAllowed,
  nodeStateFallbackDeniedMessage,
} from "../../rust-core/nodeStateFallbackCompatibilityRuntime";
import type { SqliteDb } from "./libraryRuntimeTypes";

export type RustLocalTagsReadInput = {
  dbPath: string
  rows: Array<{
    itemId: string
    aliases: string[]
    fontPath: string
  }>
}

export type RustLocalTagsReadResult = {
  tagMap: Record<string, string[]>
  knownTags?: string[]
  signature?: string
}

export type RustLocalTagsSetInput = {
  dbPath: string
  updatedAt: string
  rows: Array<{
    itemId: string
    aliases: string[]
    fontPath: string
    tagNames: string[]
  }>
}

export type RustLocalTagsSetResult = {
  updatedIds: string[]
  written: number
  previousKnownTags?: string[]
  knownTags?: string[]
  addedKnownTags?: string[]
  removedKnownTags?: string[]
  retainedEmptyTags?: string[]
  stateSignal?: RustLocalTagsMutationStateSignal
  mutationProtocol?: FontTagUpdateResult['mutationProtocol']
}

export type RustLocalTagsDeleteTagInput = {
  dbPath: string
  tagName: string
  updatedAt: string
}

export type RustLocalTagsMutationStateSignal = {
  mutationKind?: string
  dbPath?: string
  changedIds?: string[]
  updatedAt?: string
  localTagsChanged?: boolean
  cacheInvalidated?: boolean
  pageQueryDirty?: boolean
  metricsDirty?: boolean
  knownTags?: string[]
  source?: 'rust-worker' | 'node-fallback' | 'rust-daemon'
}

export type RustLocalTagsDeleteTagResult = {
  updatedIds: string[]
  updated: number
  previousKnownTags?: string[]
  knownTags?: string[]
  addedKnownTags?: string[]
  removedKnownTags?: string[]
  stateSignal?: RustLocalTagsMutationStateSignal
  mutationProtocol?: FontTagUpdateResult['mutationProtocol']
}

export type LocalFontTagsRuntimeDeps = {
  openLibraryDb: () => Promise<SqliteDb>
  librarySqlitePath: () => string
  appendStartupLog?: (message: string) => void
  runRustLocalTagsRead?: (input: RustLocalTagsReadInput) => Promise<RustLocalTagsReadResult | null>
  runRustLocalTagsSet?: (input: RustLocalTagsSetInput) => Promise<RustLocalTagsSetResult | null>
  runRustLocalTagsDeleteTag?: (input: RustLocalTagsDeleteTagInput) => Promise<RustLocalTagsDeleteTagResult | null>
  onLocalTagsMutationStateSignal?: (signal: RustLocalTagsMutationStateSignal) => void
}

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


function knownTagLifecycle(previousInput: string[] | undefined, nextInput: string[] | undefined): {
  previous: string[]
  next: string[]
  added: string[]
  removed: string[]
} {
  const previous = cleanKnownTagNames(previousInput || [])
  const next = cleanKnownTagNames(nextInput || [])
  const previousSet = new Set(previous)
  const nextSet = new Set(next)
  return {
    previous,
    next,
    added: next.filter((tag) => !previousSet.has(tag)),
    removed: previous.filter((tag) => !nextSet.has(tag)),
  }
}

function logKnownLocalTagLifecycle(options: {
  appendStartupLog?: (message: string) => void
  kind: string
  source: 'rust-worker' | 'node-fallback'
  changedIds: string[]
  previousKnownTags?: string[]
  knownTags?: string[]
  addedKnownTags?: string[]
  removedKnownTags?: string[]
  retainedEmptyTags?: string[]
}): void {
  const hasLifecycleBaseline = Array.isArray(options.previousKnownTags) || Array.isArray(options.addedKnownTags) || Array.isArray(options.removedKnownTags)
  if (!hasLifecycleBaseline) return
  const lifecycle = knownTagLifecycle(options.previousKnownTags, options.knownTags)
  const added = cleanKnownTagNames(options.addedKnownTags || lifecycle.added)
  const removed = cleanKnownTagNames(options.removedKnownTags || lifecycle.removed)
  const retainedEmpty = cleanKnownTagNames(options.retainedEmptyTags || [])
  if (retainedEmpty.length) {
    options.appendStartupLog?.(`local known tag retained empty: source=${options.source}, kind=${options.kind}, tags=${JSON.stringify(retainedEmpty)}, catalog=${lifecycle.next.length}, changedFonts=${options.changedIds.length}`)
  }
  if (removed.length) {
    options.appendStartupLog?.(`local known tag deleted: source=${options.source}, kind=${options.kind}, tags=${JSON.stringify(removed)}, previous=${lifecycle.previous.length}, next=${lifecycle.next.length}, changedFonts=${options.changedIds.length}`)
  }
  if (added.length) {
    options.appendStartupLog?.(`local known tag created: source=${options.source}, kind=${options.kind}, tags=${JSON.stringify(added)}, previous=${lifecycle.previous.length}, next=${lifecycle.next.length}, changedFonts=${options.changedIds.length}`)
  }
}

function cleanKnownTagNames(tagNamesInput: string[]): string[] {
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

function cleanLocalTagNames(tagNamesInput: string[]): string[] {
  return Array.from(
    new Set(
      (tagNamesInput || [])
        .map((tag) => String(tag || "").trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}


function rustLocalTagReadRow(item: Pick<FontItem, "id" | "sourceId" | "path">) {
  const aliases = localTagFontIdAliases(item);
  const storageId = localTagFontStorageId(item);
  if (storageId && !aliases.includes(storageId)) aliases.push(storageId);
  return {
    itemId: String(item.id || '').trim(),
    aliases: Array.from(new Set(aliases.map((id) => String(id || '').trim()).filter(Boolean))),
    fontPath: localTagFontPath(item),
  };
}

function rustLocalTagRow(item: FontItem, tagNames: string[]) {
  const aliases = localTagFontIdAliases(item);
  const storageId = localTagFontStorageId(item);
  if (storageId && !aliases.includes(storageId)) aliases.push(storageId);
  return {
    itemId: String(item.id || '').trim(),
    aliases: Array.from(new Set(aliases.map((id) => String(id || '').trim()).filter(Boolean))),
    fontPath: localTagFontPath(item),
    tagNames: cleanLocalTagNames(tagNames),
  };
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

export function createLocalFontTagsRuntime(deps: LocalFontTagsRuntimeDeps) {
  const { openLibraryDb } = deps;

  function emitLocalTagsMutationStateSignal(
    kind: string,
    updatedAt: string,
    changedIds: string[],
    knownTags?: string[],
    signal?: RustLocalTagsMutationStateSignal,
    source: 'rust-worker' | 'node-fallback' | 'rust-daemon' = 'node-fallback',
    catalogChanged = false,
  ): RustLocalTagsMutationStateSignal {
    const normalizedChangedIds = Array.isArray(signal?.changedIds) ? signal?.changedIds : changedIds;
    const changed = normalizedChangedIds.length > 0 || catalogChanged;
    const normalized: RustLocalTagsMutationStateSignal = {
      mutationKind: signal?.mutationKind || kind,
      dbPath: signal?.dbPath || deps.librarySqlitePath(),
      changedIds: normalizedChangedIds,
      updatedAt: signal?.updatedAt || updatedAt,
      localTagsChanged: signal?.localTagsChanged ?? changed,
      cacheInvalidated: signal?.cacheInvalidated ?? changed,
      pageQueryDirty: signal?.pageQueryDirty ?? changed,
      metricsDirty: signal?.metricsDirty ?? changed,
      knownTags: knownTags || signal?.knownTags,
      source: signal?.source || source,
    };
    try {
      deps.onLocalTagsMutationStateSignal?.(normalized);
    } catch {
      // State signals must not break the completed local tag write.
    }
    return normalized;
  }

  function nodeLocalTagsMutationProtocol(options: {
    command: string
    mutationKind: string
    message: string
    updatedAt: string
    changedIds: string[]
    knownTags?: string[]
    stateSignal?: RustLocalTagsMutationStateSignal
    ok?: boolean
  }): FontTagUpdateResult['mutationProtocol'] {
    return createTagMutationProtocolResult({
      ok: options.ok ?? true,
      message: options.message,
      command: options.command,
      domain: 'localTags',
      mutationKind: options.mutationKind,
      source: 'node-fallback',
      changedIds: options.changedIds,
      updatedAt: options.updatedAt,
      dbPath: deps.librarySqlitePath(),
      knownTags: options.knownTags,
      cacheInvalidated: true,
      mergedIndexDirty: false,
      pageQueryDirty: true,
      metricsDirty: true,
      stateSignal: options.stateSignal as Record<string, unknown> | undefined,
      workerMode: `node-fallback:localTags:${options.mutationKind}`,
    });
  }


  async function tryReadLocalTagsWithRust(rows: RustLocalTagsReadInput['rows']): Promise<RustLocalTagsReadResult | null> {
    if (!deps.runRustLocalTagsRead) return null;
    const usableRows = rows.filter((row) => row.itemId && (row.aliases.length > 0 || row.fontPath));
    if (!usableRows.length) return null;
    try {
      return await deps.runRustLocalTagsRead({
        dbPath: deps.librarySqlitePath(),
        rows: usableRows,
      });
    } catch (error) {
      deps.appendStartupLog?.(`rust local tags read blocked fallback: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function trySetLocalTagsWithRust(rows: RustLocalTagsSetInput['rows'], updatedAt: string): Promise<RustLocalTagsSetResult | null> {
    if (!deps.runRustLocalTagsSet) return null;
    const usableRows = rows.filter((row) => row.aliases.length > 0);
    if (!usableRows.length) return null;
    try {
      return await deps.runRustLocalTagsSet({
        dbPath: deps.librarySqlitePath(),
        updatedAt,
        rows: usableRows,
      });
    } catch (error) {
      deps.appendStartupLog?.(`rust local tags mutation blocked fallback: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async function tryDeleteLocalTagWithRust(tagName: string, updatedAt: string): Promise<RustLocalTagsDeleteTagResult | null> {
    if (!deps.runRustLocalTagsDeleteTag) return null;
    try {
      return await deps.runRustLocalTagsDeleteTag({
        dbPath: deps.librarySqlitePath(),
        tagName,
        updatedAt,
      });
    } catch (error) {
      deps.appendStartupLog?.(`rust local tag delete blocked fallback: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async function localTagsByFontIds(
    fontIds: string[],
  ): Promise<Record<string, string[]>> {
    const ids = Array.from(new Set((fontIds || []).filter(Boolean)));
    if (!ids.length) return {};
    const rustResult = await tryReadLocalTagsWithRust(ids.map((id) => ({ itemId: id, aliases: [id], fontPath: '' })));
    if (rustResult?.tagMap) return rustResult.tagMap;
    if (!nodeStateFallbackCompatibilityAllowed()) {
      logNodeStateFallbackDisabled({
        appendStartupLog: deps.appendStartupLog,
        source: 'local-tags-read',
        reason: 'rust-read-returned-empty',
      });
      return {};
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'local-tags-read',
      detail: `ids=${ids.length}`,
    });

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

  async function hydrateLocalTagsForFonts(items: FontItem[]): Promise<FontItem[]> {
    if (!items.length) return items;
    const rustResult = await tryReadLocalTagsWithRust(items.map((item) => rustLocalTagReadRow(item)));
    if (rustResult?.tagMap) {
      return items.map((item) => ({
        ...item,
        localTagNames: rustResult.tagMap[item.id] || [],
      }));
    }
    if (!nodeStateFallbackCompatibilityAllowed()) {
      logNodeStateFallbackDisabled({
        appendStartupLog: deps.appendStartupLog,
        source: 'local-tags-read',
        reason: 'rust-hydrate-returned-empty',
      });
      return items;
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'local-tags-read',
      detail: `items=${items.length}`,
    });

    const aliasToRuntimeId = new Map<string, string>();
    const pathToRuntimeId = new Map<string, string>();
    const ids: string[] = [];
    const paths: string[] = [];
    for (const item of items) {
      if (!item?.id) continue;
      const runtimeId = item.id;
      for (const id of localTagFontIdAliases(item)) {
        if (!aliasToRuntimeId.has(id)) ids.push(id);
        aliasToRuntimeId.set(id, runtimeId);
      }
      const fontPath = localTagFontPath(item);
      if (fontPath) {
        if (!pathToRuntimeId.has(fontPath)) paths.push(fontPath);
        pathToRuntimeId.set(fontPath, runtimeId);
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
      for (const row of rows) addTag(aliasToRuntimeId.get(row.font_id) || row.font_id, row.tag_name);
    }
    for (let index = 0; index < paths.length; index += chunkSize) {
      const chunk = paths.slice(index, index + chunkSize);
      const rows = db
        .prepare(
          `SELECT font_path, tag_name FROM local_font_tags WHERE font_path IN (${chunk.map(() => "?").join(",")}) ORDER BY tag_name`,
        )
        .all(...chunk) as Array<{ font_path: string; tag_name: string }>;
      for (const row of rows) addTag(pathToRuntimeId.get(row.font_path) || "", row.tag_name);
    }

    for (const tags of Object.values(tagMap)) tags.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    return items.map((item) => ({
      ...item,
      localTagNames: tagMap[item.id] || [],
    }));
  }

  async function setLocalFontTags(
    item: FontItem,
    tagNamesInput: string[],
  ): Promise<FontTagUpdateResult> {
    const tagNames = cleanLocalTagNames(tagNamesInput);
    const now = new Date().toISOString();
    const rustResult = await trySetLocalTagsWithRust([rustLocalTagRow(item, tagNames)], now);
    if (rustResult) {
      const updatedIds = rustResult.updatedIds.length ? rustResult.updatedIds : [item.id];
      logKnownLocalTagLifecycle({
        appendStartupLog: deps.appendStartupLog,
        kind: 'set',
        source: 'rust-worker',
        changedIds: updatedIds,
        previousKnownTags: rustResult.previousKnownTags,
        knownTags: rustResult.knownTags,
        addedKnownTags: rustResult.addedKnownTags,
        removedKnownTags: rustResult.removedKnownTags,
        retainedEmptyTags: rustResult.retainedEmptyTags,
      });
      emitLocalTagsMutationStateSignal('set', now, updatedIds, rustResult.knownTags, rustResult.stateSignal, 'rust-worker');
      return {
        ok: true,
        updatedIds,
        failed: [],
        message: `本地标签已更新：${item.fileName || item.id}`,
        mutationProtocol: rustResult.mutationProtocol,
      };
    }
    if (!nodeStateFallbackCompatibilityAllowed()) {
      const message = nodeStateFallbackDeniedMessage('local-tags-write');
      logNodeStateFallbackDisabled({ appendStartupLog: deps.appendStartupLog, source: 'local-tags-write' });
      return {
        ok: false,
        updatedIds: [],
        failed: [{ id: item.id, fileName: item.fileName || item.id, message }],
        message,
      };
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'local-tags-write',
      detail: `items=1`,
    });

    const db = await openLibraryDb();
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
    logKnownLocalTagLifecycle({ appendStartupLog: deps.appendStartupLog, kind: 'set', source: 'node-fallback', changedIds: [item.id], previousKnownTags, knownTags, retainedEmptyTags });
    const message = `本地标签已更新：${item.fileName || item.id}`;
    const stateSignal = emitLocalTagsMutationStateSignal('set', now, [item.id], knownTags, undefined, 'node-fallback');
    return {
      ok: true,
      updatedIds: [item.id],
      failed: [],
      message,
      mutationProtocol: nodeLocalTagsMutationProtocol({
        command: '--local-tags-set',
        mutationKind: 'set',
        message,
        updatedAt: now,
        changedIds: [item.id],
        knownTags,
        stateSignal,
      }),
    };
  }

  async function setLocalFontTagsBatch(
    itemsInput: FontTagBatchItem[],
  ): Promise<FontTagUpdateResult> {
    const unique = new Map<string, FontTagBatchItem>();
    for (const entry of itemsInput || []) {
      if (!entry?.item?.id) continue;
      unique.set(entry.item.id, entry);
    }

    const items = Array.from(unique.values());
    if (!items.length) {
      return {
        ok: true,
        updatedIds: [],
        failed: [],
        message: "没有需要更新的本地标签。",
      };
    }

    const now = new Date().toISOString();
    const rustRows = items.map((entry) => rustLocalTagRow(entry.item, entry.tagNames || []));
    const rustResult = await trySetLocalTagsWithRust(rustRows, now);
    if (rustResult) {
      logKnownLocalTagLifecycle({
        appendStartupLog: deps.appendStartupLog,
        kind: 'setBatch',
        source: 'rust-worker',
        changedIds: rustResult.updatedIds,
        previousKnownTags: rustResult.previousKnownTags,
        knownTags: rustResult.knownTags,
        addedKnownTags: rustResult.addedKnownTags,
        removedKnownTags: rustResult.removedKnownTags,
        retainedEmptyTags: rustResult.retainedEmptyTags,
      });
      emitLocalTagsMutationStateSignal('setBatch', now, rustResult.updatedIds, rustResult.knownTags, rustResult.stateSignal, 'rust-worker');
      return {
        ok: true,
        updatedIds: rustResult.updatedIds,
        failed: [],
        message: `本地标签批量更新 ${rustResult.updatedIds.length} 个。`,
        mutationProtocol: rustResult.mutationProtocol,
      };
    }
    if (!nodeStateFallbackCompatibilityAllowed()) {
      const message = nodeStateFallbackDeniedMessage('local-tags-write');
      logNodeStateFallbackDisabled({ appendStartupLog: deps.appendStartupLog, source: 'local-tags-write' });
      return {
        ok: false,
        updatedIds: [],
        failed: items.map((entry) => ({
          id: entry.item.id,
          fileName: entry.item.fileName || entry.item.id,
          message,
        })),
        message,
      };
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'local-tags-write',
      detail: `items=${items.length}`,
    });

    const db = await openLibraryDb();
    const previousKnownTags = readPersistedLocalTags(db);
    const previousBoundTags = readBoundLocalTags(db);
    const requestedKnownTags = cleanKnownTagNames(items.flatMap((entry) => entry.tagNames || []));
    const updatedIds: string[] = [];
    const failed: Array<{ id: string; fileName: string; message: string }> = [];

    let knownTags: string[] = [];
    let retainedEmptyTags: string[] = [];
    let batchStateSignal: RustLocalTagsMutationStateSignal | undefined;
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
      logKnownLocalTagLifecycle({ appendStartupLog: deps.appendStartupLog, kind: 'setBatch', source: 'node-fallback', changedIds: updatedIds, previousKnownTags, knownTags, retainedEmptyTags });
      batchStateSignal = emitLocalTagsMutationStateSignal('setBatch', now, updatedIds, knownTags, undefined, 'node-fallback');
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
    }

    const message = failed.length
      ? `本地标签批量写入失败 ${failed.length} 个。`
      : `本地标签批量更新 ${updatedIds.length} 个。`;
    return {
      ok: failed.length === 0,
      updatedIds,
      failed,
      message,
      mutationProtocol: nodeLocalTagsMutationProtocol({
        ok: failed.length === 0,
        command: '--local-tags-set',
        mutationKind: 'setBatch',
        message,
        updatedAt: now,
        changedIds: updatedIds,
        knownTags,
        stateSignal: batchStateSignal,
      }),
    };
  }


  async function deleteLocalFontTag(tagNameInput: string): Promise<FontTagUpdateResult> {
    const tagName = String(tagNameInput || "").trim();
    if (!tagName) {
      const now = new Date().toISOString();
      const message = "标签名称不能为空。";
      return {
        ok: false,
        updatedIds: [],
        failed: [],
        message,
        mutationProtocol: nodeLocalTagsMutationProtocol({
          ok: false,
          command: '--local-tags-delete-tag',
          mutationKind: 'deleteTag',
          message,
          updatedAt: now,
          changedIds: [],
        }),
      };
    }

    const now = new Date().toISOString();
    const rustResult = await tryDeleteLocalTagWithRust(tagName, now);
    if (rustResult) {
      logKnownLocalTagLifecycle({
        appendStartupLog: deps.appendStartupLog,
        kind: 'deleteTag',
        source: 'rust-worker',
        changedIds: rustResult.updatedIds,
        previousKnownTags: rustResult.previousKnownTags,
        knownTags: rustResult.knownTags,
        addedKnownTags: rustResult.addedKnownTags,
        removedKnownTags: rustResult.removedKnownTags,
      });
      emitLocalTagsMutationStateSignal('deleteTag', now, rustResult.updatedIds, rustResult.knownTags, rustResult.stateSignal, 'rust-worker');
      return {
        ok: true,
        updatedIds: rustResult.updatedIds,
        failed: [],
        message: rustResult.updatedIds.length ? `已删除本地标签“${tagName}”，更新 ${rustResult.updatedIds.length} 个字体。` : `已删除本地标签“${tagName}”。`,
        mutationProtocol: rustResult.mutationProtocol,
      };
    }
    if (!nodeStateFallbackCompatibilityAllowed()) {
      const message = nodeStateFallbackDeniedMessage('local-tags-delete');
      logNodeStateFallbackDisabled({ appendStartupLog: deps.appendStartupLog, source: 'local-tags-delete' });
      return {
        ok: false,
        updatedIds: [],
        failed: [{ id: tagName, fileName: tagName, message }],
        message,
      };
    }
    logNodeStateFallbackUsed({
      appendStartupLog: deps.appendStartupLog,
      source: 'local-tags-delete',
      detail: `tag=${tagName}`,
    });

    const db = await openLibraryDb();
    const previousKnownTags = readPersistedLocalTags(db);
    const updatedIds: string[] = [];
    let knownTags: string[] = [];
    let deleteTagStateSignal: RustLocalTagsMutationStateSignal | undefined;
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
      logKnownLocalTagLifecycle({ appendStartupLog: deps.appendStartupLog, kind: 'deleteTag', source: 'node-fallback', changedIds: updatedIds, previousKnownTags, knownTags });
      deleteTagStateSignal = emitLocalTagsMutationStateSignal(
        'deleteTag',
        now,
        updatedIds,
        knownTags,
        undefined,
        'node-fallback',
        previousKnownTags.length !== knownTags.length,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const resultMessage = `本地标签删除失败：${message}`;
      return {
        ok: false,
        updatedIds: [],
        failed: [{ id: tagName, fileName: tagName, message }],
        message: resultMessage,
        mutationProtocol: nodeLocalTagsMutationProtocol({
          ok: false,
          command: '--local-tags-delete-tag',
          mutationKind: 'deleteTag',
          message: resultMessage,
          updatedAt: now,
          changedIds: [],
        }),
      };
    }

    const message = updatedIds.length ? `已删除本地标签“${tagName}”，更新 ${updatedIds.length} 个字体。` : `已删除本地标签“${tagName}”。`;
    return {
      ok: true,
      updatedIds,
      failed: [],
      message,
      mutationProtocol: nodeLocalTagsMutationProtocol({
        command: '--local-tags-delete-tag',
        mutationKind: 'deleteTag',
        message,
        updatedAt: now,
        changedIds: updatedIds,
        knownTags,
        stateSignal: deleteTagStateSignal,
      }),
    };
  }

  return {
    localTagsByFontIds,
    hydrateLocalTagsForFonts,
    setLocalFontTags,
    setLocalFontTagsBatch,
    deleteLocalFontTag,
  };
}
