import type { SharedAvailability } from '@shared/sharedAvailability'

let snapshot: SharedAvailability | null = null
let expiresAt = 0
export function rememberPreviewAvailability(value: SharedAvailability | null): void {
  snapshot = value
  expiresAt = Date.now() + 6000
}
export function readPreviewAvailability(includeLastKnown = false): SharedAvailability | null {
  return includeLastKnown || expiresAt > Date.now() ? snapshot : null
}
