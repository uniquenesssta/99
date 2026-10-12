export async function settleMergedSyncError(error: unknown): Promise<void> {
  const failure = error as { sharedIo?: boolean; closed?: Promise<void> }
  if (failure?.sharedIo === true && failure.closed) {
    try { await failure.closed } catch { /* Preserve the original failure classification. */ }
  }
}

export function mergedSyncBlocker(error: unknown): string {
  const failure = error as { code?: string; reason?: string; message?: string }
  const code = String(failure?.code || '')
  const message = String(failure?.message || '')
  if (/SQLITE_CORRUPT|SQLITE_NOTADB/.test(code + message)) return 'corrupt-database'
  if (/EACCES|EPERM/.test(code + message)) return 'permission-denied'
  if (/SQLITE_BUSY|SQLITE_LOCKED/.test(code + message)) return 'database-busy'
  if (['queue-full','queue-timeout','execution-timeout','cancelled','stopping','closing','stale-generation','invalid-receipt','identity-unavailable'].includes(failure?.reason || '')) return failure.reason!
  if (/generation-changed|roots-changed|target-changed|source-changed/.test(message)) return 'superseded'
  if (/schema|receipt/.test(message)) return 'invalid-receipt'
  if (/unavailable/.test(message)) return 'unavailable'
  return 'source-or-projection-failed'
}


// Only fixed internal identifiers may reach diagnostic evidence, never raw
// exception text, paths, source signatures, or metadata values.
export function mergedSyncCause(error: unknown): string {
  const message = String((error as { message?: string })?.message || '')
  const causes: Record<string, string> = {
    'merged-source-changed-during-read': 'source-changed-during-read',
    'merged-source-changed-after-commit': 'source-changed-after-commit',
    'merged-projection-generation-changed': 'availability-generation-changed',
    'merged-projection-roots-changed': 'configured-roots-changed',
    'merged-projection-target-changed-in-queue': 'target-checkpoint-changed',
    'merged-projection-checkpoint-changed': 'composite-checkpoint-changed',
    'merged-projection-root-removed': 'configured-root-removed',
    'merged-source-receipt-unavailable': 'source-receipt-unavailable',
    'merged-projection-native-receipt-mismatch': 'native-receipt-mismatch',
  }
  return Object.prototype.hasOwnProperty.call(causes, message) ? causes[message] : mergedSyncBlocker(error)
}
