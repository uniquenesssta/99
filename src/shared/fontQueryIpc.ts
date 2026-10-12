import { FONT_QUERY_SUPERSEDED, hasFontQuerySupersededReason } from './fontQueryFailure'

export const FONT_QUERY_IPC_CHANNELS = ['fonts:query', 'fonts:queryPage', 'fonts:getMetrics'] as const
export type FontQueryIpcChannel = typeof FONT_QUERY_IPC_CHANNELS[number]
export type FontQueryCancelledReply = {
  readonly __hfmFontQueryReply: 1
  readonly status: 'cancelled'
  readonly reason: 'query-superseded'
}

// Only this fixed, data-free control reply crosses Electron's invoke boundary.
// Physical child closure and shared subscribers remain owned by the query task.
export const FONT_QUERY_CANCELLED_REPLY: FontQueryCancelledReply = Object.freeze({
  __hfmFontQueryReply: 1,
  status: 'cancelled',
  reason: 'query-superseded',
})

export function isFontQueryIpcChannel(channel: string): channel is FontQueryIpcChannel {
  return FONT_QUERY_IPC_CHANNELS.some(value => value === channel)
}

export function isExpectedFontQueryCancellation(channel: string, error: unknown): boolean {
  // Message matching is only a compatibility fallback after Error serialization.
  // Main-process failures must carry the authoritative cancellation reason.
  return isFontQueryIpcChannel(channel) && hasFontQuerySupersededReason(error)
}

export function decodeFontQueryReply<T>(channel: string, result: T): T {
  if (isFontQueryIpcChannel(channel) && result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>
    const keys = Object.keys(FONT_QUERY_CANCELLED_REPLY) as (keyof FontQueryCancelledReply)[]
    if (Object.keys(record).length === keys.length && keys.every(key => Object.hasOwn(record, key) && record[key] === FONT_QUERY_CANCELLED_REPLY[key])) {
      throw Object.assign(new Error(`${FONT_QUERY_SUPERSEDED} 字体查询已由当前视图替换。`), { reason: 'query-superseded' })
    }
  }
  return result
}
