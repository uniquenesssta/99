import type { FontItem } from "../../../shared/types";
import type { LocalFontTagsRuntimeDeps, RustLocalTagsReadInput, RustLocalTagsReadResult, RustLocalTagsSetInput, RustLocalTagsSetResult, RustLocalTagsDeleteTagResult } from "./localFontTagsRuntime";
import { localTagFontIdAliases, localTagFontPath, localTagFontStorageId } from "./localFontTagIdentityRuntime";
import { cleanLocalTagNames } from "./localFontTagNodePersistenceRuntime";
import { logNodeStateFallbackDisabled, logNodeStateFallbackUsed, nodeStateFallbackCompatibilityAllowed, nodeStateFallbackDeniedMessage } from "../../rust-core/nodeStateFallbackCompatibilityRuntime";

type RustAdapterDeps = Pick<LocalFontTagsRuntimeDeps, 'librarySqlitePath' | 'appendStartupLog' | 'runRustLocalTagsRead' | 'runRustLocalTagsSet' | 'runRustLocalTagsDeleteTag'>;

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

export function createLocalFontTagRustAdapterRuntime(deps: RustAdapterDeps) {
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

  function nodeFallbackDenial(options: { source: 'local-tags-read' | 'local-tags-write' | 'local-tags-delete'; detail: string; reason?: string }): string | null {
    if (!nodeStateFallbackCompatibilityAllowed()) {
      const message = options.source === 'local-tags-read' ? '' : nodeStateFallbackDeniedMessage(options.source);
      logNodeStateFallbackDisabled({ appendStartupLog: deps.appendStartupLog, source: options.source, ...(options.reason ? { reason: options.reason } : {}) });
      return message;
    }
    logNodeStateFallbackUsed({ appendStartupLog: deps.appendStartupLog, source: options.source, detail: options.detail });
    return null;
  }

  return { rustLocalTagReadRow, rustLocalTagRow, tryReadLocalTagsWithRust, trySetLocalTagsWithRust, tryDeleteLocalTagWithRust, nodeFallbackDenial };
}
