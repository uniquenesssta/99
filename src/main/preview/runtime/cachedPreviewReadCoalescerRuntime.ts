import type { FontItem } from '../../../shared/types'
import { CACHED_PREVIEW_READ_BATCH_LIMIT, CACHED_PREVIEW_READ_COALESCE_DELAY_MS } from './cachedPreviewBatchPolicyRuntime'

export type CachedPreviewReadCoalescer = {
  readSingle: (
    item: FontItem,
    text: string,
    fontSize: number,
    width: number,
    height: number,
    task: () => Promise<string>,
  ) => Promise<string>
  readBatch: (
    items: FontItem[],
    text: string,
    fontSize: number,
    width: number,
    height: number,
    task: (items: FontItem[]) => Promise<Record<string, string>>,
  ) => Promise<Record<string, string>>
}

const IN_FLIGHT_LIMIT = 160

type PendingBatchCaller = {
  items: FontItem[]
  resolve: (value: Record<string, string>) => void
  reject: (error: unknown) => void
}

type PendingBatch = {
  itemsBySignature: Map<string, FontItem>
  callers: PendingBatchCaller[]
  task: (items: FontItem[]) => Promise<Record<string, string>>
  timer: ReturnType<typeof setTimeout>
}

function itemSignature(item: FontItem): string {
  return [
    item?.id || '',
    item?.path || '',
    Math.round(Number(item?.fileSize || 0)),
    Math.round(Number(item?.modifiedAt || 0)),
  ].join('@')
}

function requestKey(prefix: string, items: FontItem[], text: string, fontSize: number, width: number, height: number): string {
  const itemKey = items.map(itemSignature).sort().join('|')
  return [prefix, text || '', fontSize, width, height, itemKey].join('::')
}

function batchGroupKey(text: string, fontSize: number, width: number, height: number): string {
  return ['batch', text || '', fontSize, width, height].join('::')
}

function filterResultForItems(items: FontItem[], result: Record<string, string>): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const item of items || []) {
    if (item?.id && result[item.id]) filtered[item.id] = result[item.id]
  }
  return filtered
}

function rememberPromise<T>(map: Map<string, Promise<T>>, key: string, task: () => Promise<T>): Promise<T> {
  const existing = map.get(key)
  if (existing) return existing
  let promise: Promise<T>
  promise = task().finally(() => {
    if (map.get(key) === promise) map.delete(key)
  })
  map.set(key, promise)
  while (map.size > IN_FLIGHT_LIMIT) {
    const oldest = map.keys().next().value
    if (!oldest) break
    map.delete(oldest)
  }
  return promise
}

export function createCachedPreviewReadCoalescerRuntime(): CachedPreviewReadCoalescer {
  const singleReads = new Map<string, Promise<string>>()
  const batchReads = new Map<string, Promise<Record<string, string>>>()
  const pendingBatches = new Map<string, PendingBatch[]>()

  function readSingle(
    item: FontItem,
    text: string,
    fontSize: number,
    width: number,
    height: number,
    task: () => Promise<string>,
  ): Promise<string> {
    return rememberPromise(singleReads, requestKey('single', [item], text, fontSize, width, height), task)
  }

  function removePendingBatch(key: string, pending: PendingBatch): void {
    const list = pendingBatches.get(key) || []
    const next = list.filter((entry) => entry !== pending)
    if (next.length) pendingBatches.set(key, next)
    else pendingBatches.delete(key)
  }

  function flushBatch(key: string, pending: PendingBatch): void {
    removePendingBatch(key, pending)
    const items = Array.from(pending.itemsBySignature.values()).slice(0, CACHED_PREVIEW_READ_BATCH_LIMIT)
    pending.task(items)
      .then((result) => {
        for (const caller of pending.callers) caller.resolve(filterResultForItems(caller.items, result || {}))
      })
      .catch((error) => {
        for (const caller of pending.callers) caller.reject(error)
      })
  }

  function createPendingBatch(key: string, task: (items: FontItem[]) => Promise<Record<string, string>>): PendingBatch {
    const pending: PendingBatch = {
      itemsBySignature: new Map<string, FontItem>(),
      callers: [],
      task,
      timer: setTimeout(() => flushBatch(key, pending), CACHED_PREVIEW_READ_COALESCE_DELAY_MS),
    }
    const list = pendingBatches.get(key) || []
    list.push(pending)
    pendingBatches.set(key, list)
    return pending
  }

  function findPendingBatch(key: string, incomingCount: number, task: (items: FontItem[]) => Promise<Record<string, string>>): PendingBatch {
    const list = pendingBatches.get(key) || []
    const pending = list.find((entry) => entry.itemsBySignature.size + incomingCount <= CACHED_PREVIEW_READ_BATCH_LIMIT)
    return pending || createPendingBatch(key, task)
  }

  function splitBatchItems(items: FontItem[]): FontItem[][] {
    const chunks: FontItem[][] = []
    for (let index = 0; index < items.length; index += CACHED_PREVIEW_READ_BATCH_LIMIT) {
      chunks.push(items.slice(index, index + CACHED_PREVIEW_READ_BATCH_LIMIT))
    }
    return chunks
  }

  function readBatchChunk(
    items: FontItem[],
    text: string,
    fontSize: number,
    width: number,
    height: number,
    task: (items: FontItem[]) => Promise<Record<string, string>>,
  ): Promise<Record<string, string>> {
    const key = batchGroupKey(text, fontSize, width, height)
    return new Promise((resolve, reject) => {
      const pending = findPendingBatch(key, items.length, task)
      for (const item of items) pending.itemsBySignature.set(itemSignature(item), item)
      pending.callers.push({ items, resolve, reject })
    })
  }

  function readBatch(
    items: FontItem[],
    text: string,
    fontSize: number,
    width: number,
    height: number,
    task: (items: FontItem[]) => Promise<Record<string, string>>,
  ): Promise<Record<string, string>> {
    const validItems = (items || []).filter((item) => item?.id)
    if (!validItems.length) return Promise.resolve({})
    return rememberPromise(batchReads, requestKey('batch-exact', validItems, text, fontSize, width, height), async () => {
      const chunks = splitBatchItems(validItems)
      if (chunks.length === 1) return readBatchChunk(chunks[0], text, fontSize, width, height, task)
      const results = await Promise.all(chunks.map((chunk) => readBatchChunk(chunk, text, fontSize, width, height, task)))
      return Object.assign({}, ...results)
    })
  }

  return { readSingle, readBatch }
}
