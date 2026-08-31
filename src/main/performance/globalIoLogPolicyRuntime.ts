import type { IoQueueSnapshot } from './ioScheduler'

const QUEUE_PRESSURE_LABELS = new Set([
  'preview:render',
  'watch:read-dir',
  'watch:stat-target',
  'watch:stat-dir',
  'watch:preflight-stat',
  'root-cache-write-lock',
  'system:installed-fonts'
])

export function shouldLogSuccessfulGlobalIo(args: {
  label: string
  durationMs: number
  thresholdMs: number
  shouldTraceStart: boolean
  after: IoQueueSnapshot
}): boolean {
  const label = String(args.label || '')
  if (args.durationMs >= args.thresholdMs) return true
  if (!QUEUE_PRESSURE_LABELS.has(label)) return false
  return args.shouldTraceStart || args.after.pending > 0
}
