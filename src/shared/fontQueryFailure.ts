// A bounded message code survives Electron's Error serialization.
export const FONT_QUERY_SUPERSEDED = '[HFM_QUERY:query-superseded]'
export function hasFontQuerySupersededReason(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { reason?: unknown }).reason === 'query-superseded'
}
export function isFontQuerySuperseded(error: unknown): boolean {
  const value = error as { reason?: string; message?: string }
  return hasFontQuerySupersededReason(error) || String(value?.message || error).includes(FONT_QUERY_SUPERSEDED)
}
