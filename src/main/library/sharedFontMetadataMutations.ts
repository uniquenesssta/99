import type {
FontItem,
FontProtectionResult,
FontTagBatchItem,
FontTagMutationProtocolResult,
FontTagUpdateResult,
} from "../../shared/types";
import type { SharedIndexMutationFailure } from "../indexing/sharedIndexMutations";
import type { SharedMetadataMergePolicy } from "../indexing/shared-metadata/sharedMetadataFieldMergeRuntime";
import { applySharedTagWriteIntent, cleanGuardTagNames, readSharedTagWriteIntent, type SharedTagWriteIntent } from "../tags/tagDomainGuardRuntime";
import { createTagMutationProtocolResult } from "./tagMutationProtocolResultRuntime";
import type { SharedKnownTagDeleteIfUnboundResult, SharedKnownTagRenameIfUnboundResult } from './sharedKnownTagsRuntime';

export interface SharedFontMetadataMutationDeps {
  appendLog?: (message: string) => void;
  syncSharedMetadataChangedIdsToMergedIndex?: (ids: string[], folders: string[], reason: string) => Promise<void>;
  uniqueResolvedFolders: (folders: string[]) => string[];
  updateSharedFontMetadataEntries: (options: {
    items: FontItem[];
    watchedFolders: string[];
    emptyPathMessage: string;
    outsideRootMessage: string;
    missingIndexMessage: string;
    missingEntryMessage: string;
    mutateFont: (font: FontItem, item: FontItem) => FontItem;
    mergePolicy?: SharedMetadataMergePolicy;
  }) => Promise<{ updatedIds: string[]; failed: SharedIndexMutationFailure[]; mutationProtocols?: FontTagMutationProtocolResult[] }>;
  removeSharedTagFromMetadataIndexes: (
    tagName: string,
    watchedFolders: string[],
  ) => Promise<{ updatedIds: string[]; failed: SharedIndexMutationFailure[]; mutationProtocols?: FontTagMutationProtocolResult[] }>;
  renameSharedTagInMetadataIndexes: (
    oldTagName: string,
    newTagName: string,
    watchedFolders: string[],
  ) => Promise<{ updatedIds: string[]; failed: SharedIndexMutationFailure[]; mutationProtocols?: FontTagMutationProtocolResult[] }>;
  invalidateSharedFontRuntimeCaches: () => void;
  syncSharedMetadataItemsToMergedIndex: (
    items: FontItem[],
    watchedFolders: string[],
    reason: string,
    options?: { emitIndexChanged?: boolean },
  ) => Promise<void>;
  syncSharedMetadataRootsToMergedIndex: (
    watchedFolders: string[],
    reason: string,
  ) => Promise<void>;
  refreshKnownSharedTagsFromMetadata?: (watchedFolders: string[], options?: { allowEmptyOverwrite?: boolean; preserveTags?: string[]; dropTags?: string[]; requireFresh?: boolean }) => Promise<string[]>;
  renameKnownSharedTagIfUnbound?: (watchedFolders: string[], oldTagName: string, newTagName: string) => Promise<SharedKnownTagRenameIfUnboundResult>;
  deleteKnownSharedTagIfUnbound?: (watchedFolders: string[], tagName: string) => Promise<SharedKnownTagDeleteIfUnboundResult>;
}

function cleanTagNames(tagNamesInput: string[]): string[] {
  return cleanGuardTagNames(tagNamesInput);
}

async function refreshKnownSharedTags(
  deps: SharedFontMetadataMutationDeps,
  folders: string[],
  options?: { allowEmptyOverwrite?: boolean; preserveTags?: string[]; dropTags?: string[]; requireFresh?: boolean },
): Promise<string[] | undefined> {
  try {
    return await deps.refreshKnownSharedTagsFromMetadata?.(folders, options);
  } catch (error) {
    deps.appendLog?.(`shared catalog read deferred after commit: cause=${String(error)}, requireFresh=${!!options?.requireFresh}; do not retry committed write`);
    // Never manufacture an empty catalog when a committed write cannot be read back.
    return undefined;
  }
}

function protectionResult(
  updatedIds: string[],
  failed: SharedIndexMutationFailure[],
  action: string,
): FontProtectionResult {
  const parts = [
    `${action} ${updatedIds.length} 个`,
    failed.length ? `失败 ${failed.length} 个` : "",
  ].filter(Boolean);

  return {
    ok: failed.length === 0,
    updatedIds,
    failed,
    message: parts.join("，") || "没有可更新的字体。",
  };
}

function mergeTagMutationProtocols(
  mutationProtocols: FontTagMutationProtocolResult[],
  message: string,
  ok: boolean,
): FontTagMutationProtocolResult | undefined {
  const protocols = mutationProtocols.filter(Boolean)
  if (!protocols.length) return undefined
  if (protocols.length === 1) {
    const { knownTags: _rootCatalog, ...protocol } = protocols[0]
    return protocol
  }
  const changedIds = Array.from(new Set(protocols.flatMap((protocol) => protocol.changedIds || [])))
  // Per-root catalogs are not a complete global catalog. Only the final read owns it.
  const same = (values: Array<string | undefined>): string | undefined => {
    const clean = Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)))
    return clean.length === 1 ? clean[0] : undefined
  }
  return createTagMutationProtocolResult({
    ok,
    message,
    command: same(protocols.map((protocol) => protocol.command)) || 'shared-metadata-multi-root',
    domain: 'sharedMetadata',
    mutationKind: same(protocols.map((protocol) => protocol.mutationKind)) || 'multiRootMutation',
    source: (same(protocols.map((protocol) => protocol.source)) as 'rust-worker' | 'rust-daemon' | 'node-fallback' | undefined) || 'node-fallback',
    changedIds,
    updatedAt: same(protocols.map((protocol) => protocol.updatedAt)) || new Date().toISOString(),
    rootPath: same(protocols.map((protocol) => protocol.rootPath)),
    cacheInvalidated: protocols.some((protocol) => protocol.cacheInvalidated !== false),
    mergedIndexDirty: protocols.some((protocol) => protocol.mergedIndexDirty !== false),
    pageQueryDirty: protocols.some((protocol) => protocol.pageQueryDirty !== false),
    metricsDirty: protocols.some((protocol) => protocol.metricsDirty !== false),
    workerMode: same(protocols.map((protocol) => protocol.workerMode)) || 'mixed:sharedMetadata:multiRootMutation',
  })
}

function tagResult(
  updatedIds: string[],
  failed: SharedIndexMutationFailure[],
  action: string,
  mutationProtocols: FontTagMutationProtocolResult[] = [],
  knownTags?: string[],
): FontTagUpdateResult {
  const parts = [
    `${action} ${updatedIds.length} 个`,
    failed.length ? `失败 ${failed.length} 个` : "",
  ].filter(Boolean);
  const message = (parts.join("，") || "没有可更新的字体。") + (knownTags === undefined ? "；共享标签目录尚未确认，请稍后重新读取。" : "");

  return {
    ok: failed.length === 0,
    updatedIds,
    failed,
    message,
    mutationProtocol: Array.isArray(knownTags)
      ? { ...(mergeTagMutationProtocols(mutationProtocols, message, failed.length === 0) || createTagMutationProtocolResult({
          command: 'shared-catalog-commit', domain: 'sharedMetadata', mutationKind: 'catalogCommit', changedIds: updatedIds,
        })), knownTags }
      : mergeTagMutationProtocols(mutationProtocols, message, failed.length === 0),
  };
}

export function createSharedFontMetadataMutations(
  deps: SharedFontMetadataMutationDeps,
) {
  async function syncCommittedTags(ids: string[], folders: string[], reason: string): Promise<void> {
    if (!ids.length) return;
    try {
      if (deps.syncSharedMetadataChangedIdsToMergedIndex) {
        await deps.syncSharedMetadataChangedIdsToMergedIndex(ids, folders, reason);
      } else {
        deps.appendLog?.(`shared metadata sync fallback: reason=${reason}, cause=changed-id-reader-unavailable`);
        await deps.syncSharedMetadataRootsToMergedIndex(folders, reason);
      }
    } catch (error) {
      deps.appendLog?.(`shared metadata sync deferred after commit: reason=${reason}, cause=${String(error)}; do not retry committed write`);
    }
  }

  async function setFontDeleteProtectionInIndex(
    items: FontItem[],
    watchedFolders: string[],
    protect: boolean,
  ): Promise<FontProtectionResult> {
    const resolvedFolders = deps.uniqueResolvedFolders(watchedFolders || []);
    const nextItems = (items || []).map((item) => ({ ...item, deleteProtected: protect }));
    const { updatedIds, failed } = await deps.updateSharedFontMetadataEntries({
      items,
      watchedFolders: resolvedFolders,
      emptyPathMessage: "字体路径为空。",
      outsideRootMessage: "字体不在当前监听文件夹内，不能写入共享保护状态。",
      missingIndexMessage: "没有找到共享索引库，请先更新索引。",
      missingEntryMessage: "共享索引中没有找到这个字体记录，请先更新索引。",
      mutateFont: (font) => ({ ...font, deleteProtected: protect }),
      mergePolicy: 'deleteProtected',
    });

    if (updatedIds.length) {
      await deps.syncSharedMetadataItemsToMergedIndex(
        nextItems.filter((item) => updatedIds.includes(item.id)),
        resolvedFolders,
        protect ? "shared-delete-protection-set" : "shared-delete-protection-clear",
        { emitIndexChanged: true },
      );
    }
    deps.invalidateSharedFontRuntimeCaches();
    return protectionResult(updatedIds, failed, protect ? "加入保护" : "取消保护");
  }

  async function setSharedFontTagsInIndex(
    items: FontItem[],
    watchedFolders: string[],
    tagNamesInput: string[],
  ): Promise<FontTagUpdateResult> {
    const tagNames = cleanTagNames(tagNamesInput);
    const resolvedFolders = deps.uniqueResolvedFolders(watchedFolders || []);
    const nextItems = (items || []).map((item) => ({ ...item, tagNames }));
    const intentById = new Map((items || []).map((item) => [item?.id, readSharedTagWriteIntent(item)] as const));
    const { updatedIds, failed, mutationProtocols } = await deps.updateSharedFontMetadataEntries({
      items: nextItems,
      watchedFolders: resolvedFolders,
      emptyPathMessage: "字体路径为空。",
      outsideRootMessage: "字体不在当前监听文件夹内，不能写入 NAS 共享标签。",
      missingIndexMessage: "没有找到共享索引库，请先更新索引。",
      missingEntryMessage: "共享索引中没有找到这个字体记录，请先更新索引。",
      mutateFont: (font, item) => {
        const intent = intentById.get(item.id)
        return {
          ...font,
          tagNames: intent ? applySharedTagWriteIntent(font.tagNames || [], tagNames, intent) : tagNames,
        }
      },
      mergePolicy: 'tags',
    });

    if (updatedIds.length) {
      await syncCommittedTags(
        updatedIds, resolvedFolders,
        "shared-tags-set-authority-refresh",
      );
    }
    const knownTags = await refreshKnownSharedTags(deps, resolvedFolders, { allowEmptyOverwrite: false, preserveTags: updatedIds.length ? tagNames : [] });
    deps.invalidateSharedFontRuntimeCaches();
    return tagResult(updatedIds, failed, "共享标签更新", mutationProtocols, knownTags);
  }

  async function setSharedFontTagsBatchInIndex(
    itemsInput: FontTagBatchItem[],
    watchedFolders: string[],
  ): Promise<FontTagUpdateResult> {
    const tagById = new Map<string, string[]>();
    const intentById = new Map<string, SharedTagWriteIntent>();
    const items = Array.from(
      new Map(
        (itemsInput || [])
          .filter((entry) => !!entry?.item?.id)
          .map((entry) => {
            const tagNames = cleanTagNames(entry.tagNames || []);
            tagById.set(entry.item.id, tagNames);
            const intent = readSharedTagWriteIntent(entry.item);
            if (intent) intentById.set(entry.item.id, intent);
            return [entry.item.id, { ...entry.item, tagNames }] as const;
          }),
      ).values(),
    );
    const resolvedFolders = deps.uniqueResolvedFolders(watchedFolders || []);

    const { updatedIds, failed, mutationProtocols } = await deps.updateSharedFontMetadataEntries({
      items,
      watchedFolders: resolvedFolders,
      emptyPathMessage: "字体路径为空。",
      outsideRootMessage: "字体不在当前监听文件夹内，不能写入 NAS 共享标签。",
      missingIndexMessage: "没有找到共享索引库，请先更新索引。",
      missingEntryMessage: "共享索引中没有找到这个字体记录，请先更新索引。",
      mutateFont: (font, item) => {
        const intent = intentById.get(item.id)
        if (intent) {
          return {
            ...font,
            tagNames: applySharedTagWriteIntent(font.tagNames || [], tagById.get(item.id) || item.tagNames || [], intent),
          }
        }
        return {
          ...font,
          tagNames: tagById.get(item.id) || item.tagNames || [],
        }
      },
      mergePolicy: 'tags',
    });

    if (updatedIds.length) {
      await syncCommittedTags(
        updatedIds, resolvedFolders,
        "shared-tags-batch-authority-refresh",
      );
    }
    const knownTags = await refreshKnownSharedTags(deps, resolvedFolders, {
      allowEmptyOverwrite: false,
      preserveTags: Array.from(new Set(items.filter((item) => updatedIds.includes(item.id)).flatMap((item) => tagById.get(item.id) || []))),
    });
    deps.invalidateSharedFontRuntimeCaches();
    return tagResult(updatedIds, failed, "共享标签批量更新", mutationProtocols, knownTags);
  }


  async function renameSharedFontTagInIndex(
    oldTagNameInput: string,
    newTagNameInput: string,
    watchedFolders: string[],
  ): Promise<FontTagUpdateResult> {
    const oldTagName = String(oldTagNameInput || "").trim();
    const newTagName = String(newTagNameInput || "").trim();
    if (!oldTagName || !newTagName) return { ok: false, updatedIds: [], failed: [], message: "共享标签名称不能为空。" };
    if (oldTagName === newTagName) return { ok: true, updatedIds: [], failed: [], message: "共享标签名称没有变化。" };

    const resolvedFolders = deps.uniqueResolvedFolders(watchedFolders || []);
    const knownOnlyRename = await deps.renameKnownSharedTagIfUnbound?.(resolvedFolders, oldTagName, newTagName).catch(() => null);
    if (knownOnlyRename?.renamed) {
      deps.invalidateSharedFontRuntimeCaches();
      return tagResult([], [], `重命名共享标签“${oldTagName}”为“${newTagName}”`, [createTagMutationProtocolResult({
        ok: true,
        message: `重命名共享标签“${oldTagName}”为“${newTagName}”`,
        command: 'shared-known-tag-zero-bind-rename',
        domain: 'sharedMetadata',
        mutationKind: 'renameTag',
        source: 'node-fallback',
        changedIds: [],
        knownTags: knownOnlyRename.nextTags,
        updatedAt: new Date().toISOString(),
        cacheInvalidated: true,
        mergedIndexDirty: false,
        pageQueryDirty: true,
        metricsDirty: true,
        workerMode: 'node:sharedKnownTags:zeroBindRename',
      })], knownOnlyRename.nextTags);
    }

    const { updatedIds, failed, mutationProtocols } = await deps.renameSharedTagInMetadataIndexes(
      oldTagName,
      newTagName,
      resolvedFolders,
    );

    if (updatedIds.length) {
      await syncCommittedTags(
        updatedIds, resolvedFolders,
        `shared-tag-rename:${oldTagName}->${newTagName}`,
      );
    }
    const knownTags = await refreshKnownSharedTags(deps, resolvedFolders, {
      allowEmptyOverwrite: false,
      preserveTags: updatedIds.length ? [newTagName] : [],
      dropTags: failed.length ? [] : [oldTagName],
      requireFresh: !failed.length,
    });
    deps.invalidateSharedFontRuntimeCaches();
    return tagResult(updatedIds, failed, `重命名共享标签“${oldTagName}”为“${newTagName}”`, mutationProtocols, knownTags);
  }

  async function deleteSharedFontTagInIndex(
    tagNameInput: string,
    watchedFolders: string[],
  ): Promise<FontTagUpdateResult> {
    const tagName = String(tagNameInput || "").trim();
    if (!tagName) return { ok: false, updatedIds: [], failed: [], message: "共享标签名称不能为空。" };

    const resolvedFolders = deps.uniqueResolvedFolders(watchedFolders || []);
    const knownOnlyDelete = await deps.deleteKnownSharedTagIfUnbound?.(resolvedFolders, tagName).catch(() => null);
    if (knownOnlyDelete?.deleted) {
      deps.invalidateSharedFontRuntimeCaches();
      return tagResult([], [], `删除共享标签“${tagName}”`, [createTagMutationProtocolResult({
        ok: true,
        message: `删除共享标签“${tagName}”`,
        command: 'shared-known-tag-zero-bind-delete',
        domain: 'sharedMetadata',
        mutationKind: 'deleteTag',
        source: 'node-fallback',
        changedIds: [],
        knownTags: knownOnlyDelete.nextTags,
        updatedAt: new Date().toISOString(),
        cacheInvalidated: true,
        mergedIndexDirty: false,
        pageQueryDirty: true,
        metricsDirty: true,
        workerMode: 'node:sharedKnownTags:zeroBindDelete',
      })], knownOnlyDelete.nextTags);
    }

    const { updatedIds, failed, mutationProtocols } = await deps.removeSharedTagFromMetadataIndexes(
      tagName,
      resolvedFolders,
    );

    if (updatedIds.length) {
      await syncCommittedTags(
        updatedIds, resolvedFolders,
        `shared-tag-delete:${tagName}`,
      );
    }
    const knownTags = await refreshKnownSharedTags(deps, resolvedFolders, { allowEmptyOverwrite: false, dropTags: failed.length ? [] : [tagName], requireFresh: !failed.length });
    deps.invalidateSharedFontRuntimeCaches();
    return tagResult(updatedIds, failed, `删除共享标签“${tagName}”`, mutationProtocols, knownTags);
  }

  return {
    setFontDeleteProtectionInIndex,
    setSharedFontTagsInIndex,
    setSharedFontTagsBatchInIndex,
    renameSharedFontTagInIndex,
    deleteSharedFontTagInIndex,
  };
}
