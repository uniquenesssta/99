import type { FontQueryRequest } from "../../../shared/types";

export function requestNeedsValidatedMergedIndex(request: FontQueryRequest): boolean {
  const activeKind = request.activeFilter?.kind || "all";
  return activeKind === "active";
}
