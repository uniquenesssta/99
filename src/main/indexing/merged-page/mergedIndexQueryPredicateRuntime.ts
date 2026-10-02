import type { FontQueryRequest } from "../../../shared/types";

export function requestNeedsValidatedMergedIndex(_request: FontQueryRequest): boolean {
  // Pending activation is gated by the facade; persisted state is indexed.
  return false;
}
