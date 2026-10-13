// The caller owns the SQLite read snapshot. Projection receipts must be taken
// from that same snapshot as the rows, never from a second independently opened DB.
export function installStatusContentSignatureFromDb(db: any): string {
  const row = db.prepare(`SELECT COUNT(*) AS count,
    COALESCE(SUM(CASE WHEN installed = 1 AND by_type <> 'managed' THEN 1 ELSE 0 END), 0) AS installed_count,
    COALESCE(SUM(CASE WHEN by_type IN ('managed', 'both') THEN 1 ELSE 0 END), 0) AS active_count,
    COALESCE(MAX(checked_at), '') AS max_checked_at FROM install_status`).get()
  return ['install-content-v1', Number(row?.count || 0), Number(row?.installed_count || 0),
    Number(row?.active_count || 0), String(row?.max_checked_at || '')].join('|')
}
