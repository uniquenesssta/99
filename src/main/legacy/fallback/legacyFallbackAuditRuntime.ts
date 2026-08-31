export type LegacyFallbackAuditItem = {
  name: string
  category: 'keep-electron-boundary' | 'explicit-compatibility-only'
  reason: string
}

export const LEGACY_FALLBACK_AUDIT_ITEMS: LegacyFallbackAuditItem[] = [
  {
    name: 'Electron window/menu/tray/dialog/shell APIs',
    category: 'keep-electron-boundary',
    reason: 'Electron-owned UI and OS shell APIs must remain in the Node/Electron boundary.',
  },
  {
    name: 'fontkit scan worker',
    category: 'explicit-compatibility-only',
    reason: 'Rust parse batch is the default path; Node/fontkit fallback is blocked unless HFM_NODE_FONTKIT_SCAN_FALLBACK=1 is explicit.',
  },
  {
    name: 'db-query-worker',
    category: 'explicit-compatibility-only',
    reason: 'Rust merged-index page/metrics/ids queries are daemon-backed; db-query-worker is blocked unless HFM_NODE_DB_QUERY_FALLBACK=1 is explicit.',
  },
  {
    name: 'preview fallback sqlite/PowerShell/native-helper paths',
    category: 'explicit-compatibility-only',
    reason: 'Rust preview render/cache routes are the default; DirectWrite/PowerShell bridge fallback is blocked unless HFM_NODE_BRIDGE_FALLBACK=1 is explicit.',
  },
  {
    name: 'Node SQLite shared metadata mutation fallback',
    category: 'explicit-compatibility-only',
    reason: 'Rust shared metadata state machine is daemon-backed; Node SQLite mutation fallback is blocked unless HFM_NODE_STATE_FALLBACK=1 is explicit.',
  },
  {
    name: 'Node root/merged index write fallback',
    category: 'explicit-compatibility-only',
    reason: 'Rust root/merged index writes are daemon-backed; Node write fallback is blocked unless HFM_NODE_STATE_FALLBACK=1 is explicit.',
  },
]

export function legacyFallbackAuditHasPendingDeleteAfterLogsClean(): boolean {
  return LEGACY_FALLBACK_AUDIT_ITEMS.some((item) => (item as { category?: string }).category === 'delete-after-logs-clean')
}

export function legacyFallbackAuditCompletionSummary(): string {
  const pending = legacyFallbackAuditHasPendingDeleteAfterLogsClean() ? 'pending-delete-after-logs-clean' : 'no-pending-delete-after-logs-clean'
  return `${legacyFallbackAuditSummary()}, finalClosure=${pending}`
}

export function legacyFallbackAuditSummary(): string {
  const counts = LEGACY_FALLBACK_AUDIT_ITEMS.reduce<Record<string, number>>((acc, item) => {
    acc[item.category] = (acc[item.category] || 0) + 1
    return acc
  }, {})
  return Object.entries(counts)
    .map(([category, count]) => `${category}=${count}`)
    .join(', ')
}
