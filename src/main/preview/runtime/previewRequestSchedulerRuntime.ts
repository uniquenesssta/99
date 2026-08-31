import type { FontItem } from '../../../shared/types'
import { previewCacheQueryTimeoutMs,withIoDeadlineResult } from '../../path/ioDeadlineRuntime'

const DEFAULT_PREVIEW_SCHEDULER_BATCH_LIMIT = 100
const DEFAULT_PREVIEW_SCHEDULER_COALESCE_DELAY_MS = 32
const DEFAULT_PREVIEW_SCHEDULER_MAX_IN_FLIGHT = 1
const DEFAULT_PREVIEW_SCHEDULER_QUEUE_LIMIT = 24
const DEFAULT_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS = 2000
const DEFAULT_PREVIEW_SCHEDULER_LOG_INTERVAL_MS = 5000

export type PreviewRequestSchedulerOptions = {
  readCachedPreviewImages: (items: FontItem[], text: string, fontSize: number, width: number, height: number) => Promise<Record<string, string>>
  appendStartupLog?: (message: string) => void
}

export type PreviewRequestSchedulerRuntime = {
  readCachedPreviewImages: (items: FontItem[], text: string, fontSize: number, width: number, height: number) => Promise<Record<string, string>>
}

type PreviewCaller = {
  items: FontItem[]
  resolve: (value: Record<string, string>) => void
  reject: (error: unknown) => void
  createdAt: number
  completed: boolean
  remainingBatches: number
  result: Record<string, string>
  timer: ReturnType<typeof setTimeout>
}

type PendingGroup = {
  key: string
  text: string
  fontSize: number
  width: number
  height: number
  itemsBySignature: Map<string, FontItem>
  callers: PreviewCaller[]
  timer: ReturnType<typeof setTimeout>
}

type WorkBatch = {
  text: string
  fontSize: number
  width: number
  height: number
  items: FontItem[]
  callers: PreviewCaller[]
  enqueuedAt: number
}

function parseEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function previewSchedulerBatchLimit(): number {
  return parseEnvInt('HFM_PREVIEW_SCHEDULER_BATCH_LIMIT', DEFAULT_PREVIEW_SCHEDULER_BATCH_LIMIT, 20, 400)
}

function previewSchedulerCoalesceDelayMs(): number {
  return parseEnvInt('HFM_PREVIEW_SCHEDULER_COALESCE_DELAY_MS', DEFAULT_PREVIEW_SCHEDULER_COALESCE_DELAY_MS, 0, 250)
}

function previewSchedulerMaxInFlight(): number {
  return parseEnvInt('HFM_PREVIEW_SCHEDULER_MAX_IN_FLIGHT', DEFAULT_PREVIEW_SCHEDULER_MAX_IN_FLIGHT, 1, 4)
}

function previewSchedulerQueueLimit(): number {
  return parseEnvInt('HFM_PREVIEW_SCHEDULER_QUEUE_LIMIT', DEFAULT_PREVIEW_SCHEDULER_QUEUE_LIMIT, 2, 200)
}

function previewSchedulerRequestTimeoutMs(): number {
  return parseEnvInt('HFM_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS', previewCacheQueryTimeoutMs() || DEFAULT_PREVIEW_SCHEDULER_REQUEST_TIMEOUT_MS, 500, 30000)
}

function itemSignature(item: FontItem): string {
  return [
    item?.id || '',
    item?.path || '',
    Math.round(Number(item?.fileSize || 0)),
    Math.round(Number(item?.modifiedAt || 0)),
  ].join('@')
}

function schedulerGroupKey(text: string, fontSize: number, width: number, height: number): string {
  return [text || '', Math.round(Number(fontSize || 0)), Math.round(Number(width || 0)), Math.round(Number(height || 0))].join('::')
}

function uniqueValidItems(items: FontItem[]): FontItem[] {
  const seen = new Set<string>()
  const result: FontItem[] = []
  for (const item of items || []) {
    if (!item?.id) continue
    const signature = itemSignature(item)
    if (seen.has(signature)) continue
    seen.add(signature)
    result.push(item)
  }
  return result
}

function filterResultForItems(items: FontItem[], result: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const item of items || []) {
    if (item?.id && result[item.id]) filtered[item.id] = result[item.id]
  }
  return filtered
}

export function createPreviewRequestSchedulerRuntime(options: PreviewRequestSchedulerOptions): PreviewRequestSchedulerRuntime {
  const pendingGroups = new Map<string, PendingGroup[]>()
  const queue: WorkBatch[] = []
  let active = 0
  let lastPressureLogAt = 0

  function logPressure(message: string): void {
    if (!options.appendStartupLog) return
    const now = Date.now()
    if (now - lastPressureLogAt < DEFAULT_PREVIEW_SCHEDULER_LOG_INTERVAL_MS) return
    lastPressureLogAt = now
    options.appendStartupLog(message)
  }

  function resolveCaller(caller: PreviewCaller, value: Record<string, string>): void {
    if (caller.completed) return
    caller.completed = true
    clearTimeout(caller.timer)
    caller.resolve(value)
  }

  function rejectCaller(caller: PreviewCaller, error: unknown): void {
    if (caller.completed) return
    caller.completed = true
    clearTimeout(caller.timer)
    caller.reject(error)
  }

  function expireCaller(caller: PreviewCaller): void {
    if (caller.completed) return
    caller.completed = true
    caller.resolve({ ...caller.result })
  }

  function completeCallerBatch(caller: PreviewCaller, value: Record<string, string>): void {
    if (caller.completed) return
    Object.assign(caller.result, value)
    caller.remainingBatches = Math.max(0, caller.remainingBatches - 1)
    if (caller.remainingBatches === 0) resolveCaller(caller, { ...caller.result })
  }

  function removePendingGroup(group: PendingGroup): void {
    const list = pendingGroups.get(group.key) || []
    const next = list.filter((entry) => entry !== group)
    if (next.length) pendingGroups.set(group.key, next)
    else pendingGroups.delete(group.key)
  }

  function trimQueue(): void {
    const limit = previewSchedulerQueueLimit()
    while (queue.length > limit) {
      const dropped = queue.shift()
      if (!dropped) break
      for (const caller of dropped.callers) completeCallerBatch(caller, {})
    }
  }

  function pump(): void {
    const maxInFlight = previewSchedulerMaxInFlight()
    while (active < maxInFlight && queue.length) {
      const batch = queue.shift()
      if (!batch) continue
      const liveCallers = batch.callers.filter((caller) => !caller.completed)
      if (!liveCallers.length) continue
      active += 1
      runBatch({ ...batch, callers: liveCallers })
        .finally(() => {
          active = Math.max(0, active - 1)
          pump()
        })
    }
  }

  function enqueueBatch(batch: WorkBatch): void {
    queue.push(batch)
    trimQueue()
    if (queue.length > 4 || active >= previewSchedulerMaxInFlight()) {
      logPressure(`preview request scheduler pressure: queue=${queue.length}, active=${active}, callers=${batch.callers.length}, items=${batch.items.length}`)
    }
    pump()
  }

  function flushPendingGroup(group: PendingGroup): void {
    removePendingGroup(group)
    const liveCallers = group.callers.filter((caller) => !caller.completed)
    const liveSignatures = new Set<string>()
    for (const caller of liveCallers) {
      for (const item of caller.items) liveSignatures.add(itemSignature(item))
    }
    const items = Array.from(group.itemsBySignature.entries())
      .filter(([signature]) => liveSignatures.has(signature))
      .map(([, item]) => item)
    if (!items.length) {
      for (const caller of liveCallers) completeCallerBatch(caller, {})
      return
    }

    const batchLimit = previewSchedulerBatchLimit()
    const chunks: Array<{ items: FontItem[]; signatures: Set<string> }> = []
    for (let index = 0; index < items.length; index += batchLimit) {
      const chunk = items.slice(index, index + batchLimit)
      chunks.push({ items: chunk, signatures: new Set(chunk.map(itemSignature)) })
    }

    for (const caller of liveCallers) {
      caller.remainingBatches = chunks.reduce(
        (count, chunk) => count + (caller.items.some((item) => chunk.signatures.has(itemSignature(item))) ? 1 : 0),
        0,
      )
      if (caller.remainingBatches === 0) resolveCaller(caller, {})
    }

    for (const chunk of chunks) {
      const chunkCallers = liveCallers.filter((caller) => caller.items.some((item) => chunk.signatures.has(itemSignature(item))))
      enqueueBatch({
        text: group.text,
        fontSize: group.fontSize,
        width: group.width,
        height: group.height,
        items: chunk.items,
        callers: chunkCallers,
        enqueuedAt: Date.now(),
      })
    }
  }

  function createPendingGroup(key: string, text: string, fontSize: number, width: number, height: number): PendingGroup {
    let group: PendingGroup
    const timer = setTimeout(() => flushPendingGroup(group), previewSchedulerCoalesceDelayMs())
    group = {
      key,
      text,
      fontSize,
      width,
      height,
      itemsBySignature: new Map<string, FontItem>(),
      callers: [],
      timer,
    }
    const list = pendingGroups.get(key) || []
    list.push(group)
    pendingGroups.set(key, list)
    return group
  }

  function findPendingGroup(key: string, incomingCount: number, text: string, fontSize: number, width: number, height: number): PendingGroup {
    const batchLimit = previewSchedulerBatchLimit()
    const list = pendingGroups.get(key) || []
    const existing = list.find((group) => group.itemsBySignature.size + incomingCount <= batchLimit)
    return existing || createPendingGroup(key, text, fontSize, width, height)
  }

  async function runBatch(batch: WorkBatch): Promise<void> {
    const liveCallers = batch.callers.filter((caller) => !caller.completed)
    if (!liveCallers.length) return
    const taskLabel = `preview-scheduler-cache-read:${batch.items.length}:${Date.now()}`
    const result = await withIoDeadlineResult(
      taskLabel,
      () => options.readCachedPreviewImages(batch.items, batch.text, batch.fontSize, batch.width, batch.height),
      previewSchedulerRequestTimeoutMs(),
    )

    if (!result.ok) {
      logPressure(`preview request scheduler deadline dropped: items=${batch.items.length}, queueWaitMs=${Date.now() - batch.enqueuedAt}, ${result.error instanceof Error ? result.error.message : String(result.error)}`)
      for (const caller of liveCallers) completeCallerBatch(caller, {})
      return
    }

    for (const caller of liveCallers) {
      completeCallerBatch(caller, filterResultForItems(caller.items, result.value || {}))
    }
  }

  function readCachedPreviewImages(items: FontItem[], text: string, fontSize = 34, width = 520, height = 150): Promise<Record<string, string>> {
    const validItems = uniqueValidItems(items || [])
    if (!validItems.length) return Promise.resolve({})

    const timeoutMs = previewSchedulerRequestTimeoutMs()
    return new Promise((resolve, reject) => {
      let caller: PreviewCaller
      const timer = setTimeout(() => expireCaller(caller), timeoutMs)
      caller = {
        items: validItems,
        resolve,
        reject,
        createdAt: Date.now(),
        completed: false,
        remainingBatches: 0,
        result: {},
        timer,
      }

      const key = schedulerGroupKey(text, fontSize, width, height)
      const group = findPendingGroup(key, validItems.length, text, fontSize, width, height)
      for (const item of validItems) group.itemsBySignature.set(itemSignature(item), item)
      group.callers.push(caller)

      if (group.itemsBySignature.size >= previewSchedulerBatchLimit()) {
        clearTimeout(group.timer)
        flushPendingGroup(group)
      }
    })
  }

  return { readCachedPreviewImages }
}
