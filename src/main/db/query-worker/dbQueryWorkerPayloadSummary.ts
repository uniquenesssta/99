import type { DbWorkerRequestMessage } from "./dbQueryWorkerTypes";

export function summarizeDbWorkerPayload(
  message: Omit<DbWorkerRequestMessage, "id">,
): string {
  try {
    const payload = (message as { payload?: unknown }).payload as
      | Record<string, unknown>
      | undefined;
    if (!payload) return "{}";
    if (message.type === "queryMergedIndexPage") {
      const request = (payload.request || {}) as Record<string, unknown>;
      const activeFilter = (request.activeFilter || {}) as Record<string, unknown>;
      return JSON.stringify({
        queryKey: String(payload.queryKey || "").slice(0, 16),
        roots: Array.isArray(payload.roots) ? payload.roots.length : 0,
        offset: payload.offset,
        limit: payload.limit,
        sidebarPage: request.sidebarPage || request.page,
        keyword: request.keyword || request.search,
        activeFilterKind: activeFilter.kind || "all",
        activeFilterName: activeFilter.name,
        installStatus: request.installStatus || "all",
        selectedFolderId: request.selectedFolderId,
      });
    }
    if (message.type === "queryMergedIndexMetrics") {
      return JSON.stringify({
        roots: Array.isArray(payload.roots) ? payload.roots.length : 0,
      });
    }
    if (message.type === "readInstallStatusIndex") {
      const groups = Array.isArray(payload.groups)
        ? (payload.groups as Array<{ items?: unknown[] }>)
        : [];
      return JSON.stringify({
        groups: groups.length,
        items: groups.reduce(
          (sum, group) => sum + (Array.isArray(group.items) ? group.items.length : 0),
          0,
        ),
      });
    }
    if (message.type === "saveInstallStatusIndex") {
      const groups = Array.isArray(payload.groups)
        ? (payload.groups as Array<{ rows?: unknown[] }>)
        : [];
      return JSON.stringify({
        groups: groups.length,
        rows: groups.reduce(
          (sum, group) => sum + (Array.isArray(group.rows) ? group.rows.length : 0),
          0,
        ),
      });
    }
    return JSON.stringify({ keys: Object.keys(payload).slice(0, 10) });
  } catch {
    return "[unserializable]";
  }
}
