import type { FontItem } from "../../../shared/types";

export function normalizeLocalTagFontPath(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/g, "")
    .toLowerCase();
}

export function localTagFontPath(item: Pick<FontItem, "path"> | undefined): string {
  return normalizeLocalTagFontPath(item?.path);
}

export function localTagFontStorageId(item: Pick<FontItem, "id" | "sourceId"> | undefined): string {
  return String(item?.id || "").trim() || String(item?.sourceId || "").trim();
}

export function localTagFontIdAliases(item: Pick<FontItem, "id" | "sourceId"> | undefined): string[] {
  const aliases = new Set<string>();
  for (const raw of [item?.id, item?.sourceId, localTagFontStorageId(item)]) {
    const id = String(raw || "").trim();
    if (id) aliases.add(id);
  }
  return Array.from(aliases);
}
