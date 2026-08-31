export function rustFullMigrationEnabled(): boolean {
  const mode = String(process.env.HFM_RUST_FULL_MIGRATION || '1').trim().toLowerCase()
  return mode !== '0' && mode !== 'false' && mode !== 'off'
}

export function nodeFontkitScanFallbackEnabled(): boolean {
  const mode = String(process.env.HFM_NODE_FONTKIT_SCAN_FALLBACK || '').trim().toLowerCase()
  return mode === '1' || mode === 'true' || mode === 'on'
}

export function nodeDbQueryFallbackEnabled(): boolean {
  const mode = String(process.env.HFM_NODE_DB_QUERY_FALLBACK || '').trim().toLowerCase()
  return mode === '1' || mode === 'true' || mode === 'on'
}
