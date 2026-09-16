import { createLocalFontTagRustAdapterRuntime } from "./localFontTagRustAdapterRuntime";
import { createLocalFontTagMutationEffectsRuntime, logKnownLocalTagLifecycle } from "./localFontTagMutationEffectsRuntime";
import type {
FontItem,
FontTagBatchItem,
FontTagUpdateResult,
} from "../../../shared/types";
import { createLocalFontTagNodePersistenceRuntime, cleanLocalTagNames } from "./localFontTagNodePersistenceRuntime";

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
  trace?: import('../../../shared/operationTrace').OperationTrace
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

export function createLocalFontTagsRuntime(deps: LocalFontTagsRuntimeDeps) {
  const { rustLocalTagReadRow, rustLocalTagRow, tryReadLocalTagsWithRust, trySetLocalTagsWithRust, tryDeleteLocalTagWithRust, nodeFallbackDenial } = createLocalFontTagRustAdapterRuntime(deps);
  const { emitLocalTagsMutationStateSignal, nodeLocalTagsMutationProtocol } = createLocalFontTagMutationEffectsRuntime(deps);
  const nodePersistence = createLocalFontTagNodePersistenceRuntime(deps.openLibraryDb);

  async function localTagsByFontIds(
    fontIds: string[],
  ): Promise<Record<string, string[]>> {
    const ids = Array.from(new Set((fontIds || []).filter(Boolean)));
    if (!ids.length) return {};
    const rustResult = await tryReadLocalTagsWithRust(ids.map((id) => ({ itemId: id, aliases: [id], fontPath: '' })));
    if (rustResult?.tagMap) return rustResult.tagMap;
    if (nodeFallbackDenial({ source: 'local-tags-read', reason: 'rust-read-returned-empty', detail: `ids=${ids.length}` }) !== null) return {};

    return nodePersistence.localTagsByFontIds(ids);
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
    if (nodeFallbackDenial({ source: 'local-tags-read', reason: 'rust-hydrate-returned-empty', detail: `items=${items.length}` }) !== null) return items;

    return nodePersistence.hydrateLocalTagsForFonts(items);
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
    const deniedMessage = nodeFallbackDenial({ source: 'local-tags-write', detail: `items=1` });
    if (deniedMessage !== null) {
      const message = deniedMessage;
      return {
        ok: false,
        updatedIds: [],
        failed: [{ id: item.id, fileName: item.fileName || item.id, message }],
        message,
      };
    }

    const { previousKnownTags, knownTags, retainedEmptyTags } = (await nodePersistence.openWriter()).setLocalFontTags(item, tagNames, now);
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
    const deniedMessage = nodeFallbackDenial({ source: 'local-tags-write', detail: `items=${items.length}` });
    if (deniedMessage !== null) {
      const message = deniedMessage;
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

    const { updatedIds, failed, previousKnownTags, knownTags, retainedEmptyTags } = (await nodePersistence.openWriter()).setLocalFontTagsBatch(items, now);
    let batchStateSignal: RustLocalTagsMutationStateSignal | undefined;
    if (!failed.length) {
      logKnownLocalTagLifecycle({ appendStartupLog: deps.appendStartupLog, kind: 'setBatch', source: 'node-fallback', changedIds: updatedIds, previousKnownTags, knownTags, retainedEmptyTags });
      batchStateSignal = emitLocalTagsMutationStateSignal('setBatch', now, updatedIds, knownTags, undefined, 'node-fallback');
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
    const deniedMessage = nodeFallbackDenial({ source: 'local-tags-delete', detail: `tag=${tagName}` });
    if (deniedMessage !== null) {
      const message = deniedMessage;
      return {
        ok: false,
        updatedIds: [],
        failed: [{ id: tagName, fileName: tagName, message }],
        message,
      };
    }

    const persisted = (await nodePersistence.openWriter()).deleteLocalFontTag(tagName);
    if (!persisted.ok) {
      const message = persisted.message;
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
    const { updatedIds, previousKnownTags, knownTags } = persisted;
    logKnownLocalTagLifecycle({ appendStartupLog: deps.appendStartupLog, kind: 'deleteTag', source: 'node-fallback', changedIds: updatedIds, previousKnownTags, knownTags });
    const deleteTagStateSignal = emitLocalTagsMutationStateSignal(
      'deleteTag',
      now,
      updatedIds,
      knownTags,
      undefined,
      'node-fallback',
      previousKnownTags.length !== knownTags.length,
    );

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
