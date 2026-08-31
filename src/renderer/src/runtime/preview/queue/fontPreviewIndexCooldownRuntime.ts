let previewQueueCooldownUntil = 0

export function pausePreviewQueueAfterIndexing(delayMs = 1800): void {
  previewQueueCooldownUntil = Math.max(previewQueueCooldownUntil, Date.now() + Math.max(0, delayMs))
}

export function previewQueueCooldownRemaining(now = Date.now()): number {
  return Math.max(0, previewQueueCooldownUntil - now)
}
