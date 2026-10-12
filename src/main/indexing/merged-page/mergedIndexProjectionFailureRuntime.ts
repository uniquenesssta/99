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

