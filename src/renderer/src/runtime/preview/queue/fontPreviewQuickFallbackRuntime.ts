import type { FontItem } from '@shared/types'

export const QUICK_WEBFONT_URL_TIMEOUT_MS = 180
export const QUICK_WEBFONT_BINARY_TIMEOUT_MS = 120
export const QUICK_WEBFONT_TOTAL_BUDGET_MS = 300
export const QUICK_WEBFONT_BINARY_MAX_BYTES = 2 * 1024 * 1024

export function binaryWebFontQuickFallbackEnabled(): boolean {
  return String(import.meta.env?.VITE_HFM_PREVIEW_BINARY_WEBFONT_FALLBACK || '').trim() === '1'
}

export class QuickPreviewTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuickPreviewTimeoutError'
  }
}

export function lowerFontPreviewPath(font: FontItem): string {
  return String(font.path || font.fileName || '').toLowerCase()
}

export function isFontCollectionOrLargeFont(font: FontItem): boolean {
  const path = lowerFontPreviewPath(font)
  const size = Number(font.fileSize || 0)
  return font.format === 'ttc' || path.endsWith('.ttc') || size >= 8 * 1024 * 1024
}

export function canUseBinaryWebFontQuickFallback(font: FontItem): boolean {
  if (!binaryWebFontQuickFallbackEnabled()) return false
  const path = lowerFontPreviewPath(font)
  const size = Number(font.fileSize || 0)
  if (font.format === 'ttc' || path.endsWith('.ttc')) return false
  if (size <= 0 || size > QUICK_WEBFONT_BINARY_MAX_BYTES) return false
  return path.endsWith('.ttf') || path.endsWith('.otf') || font.format === 'ttf' || font.format === 'otf'
}

export function remainingQuickPreviewBudget(startedAt: number, totalBudgetMs = QUICK_WEBFONT_TOTAL_BUDGET_MS): number {
  return Math.max(0, totalBudgetMs - Math.round(performance.now() - startedAt))
}

export function quickPreviewBudgetExpired(startedAt: number): boolean {
  return remainingQuickPreviewBudget(startedAt) <= 0
}

export async function withQuickPreviewTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  registerCancellation?: (cancel: () => void) => () => void
): Promise<T> {
  let timer: number | undefined
  let unsubscribe: (() => void) | undefined
  const timeout = new Promise<never>((_, reject) => {
    unsubscribe = registerCancellation?.(() => reject(Object.assign(new Error('预览等待已取消。'), { name: 'AbortError' })))
    timer = window.setTimeout(() => {
      reject(new QuickPreviewTimeoutError(`${label} 超过 ${timeoutMs}ms，已切换原生预览。`))
    }, Math.max(1, timeoutMs))
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    unsubscribe?.()
    if (timer !== undefined) window.clearTimeout(timer)
  }
}

// FontFace.load has no cancellation API. Slots follow the load promise, never
// its UI deadline. Only a current caller may attach a completed face to the DOM.
export function createFontFaceLoadOwner(limit = 5, retainedLimit = 128) {
  const entries = new Map<string, { promise: Promise<FontFace>; pending: boolean }>()
  const waiters = new Set<() => void>()
  function withinBudget<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return withQuickPreviewTimeout(promise, timeoutMs, label, cancel => {
      waiters.add(cancel)
      return () => { waiters.delete(cancel) }
    })
  }
  let active = 0
  let generation = 0
  async function load(key: string, create: () => FontFace, timeoutMs: number, label: string, settled?: (outcome: string) => void): Promise<FontFace> {
    let entry = entries.get(key)
    if (!entry) {
      if (active >= limit) throw new QuickPreviewTimeoutError('WebFont 实际在途上限，改用原生预览。')
      const epoch = generation
      active += 1
      const promise = Promise.resolve().then(() => create().load())
      entry = { promise, pending: true }
      entries.set(key, entry)
      const owned = entry
      void promise.then(() => {
        owned.pending = false
        if (epoch !== generation && entries.get(key) === owned) entries.delete(key)
        for (const [oldKey, oldEntry] of entries) {
          if (entries.size <= retainedLimit) break
          if (!oldEntry.pending) entries.delete(oldKey)
        }
        settled?.('loaded')
      }, () => {
        if (entries.get(key) === owned) entries.delete(key)
        settled?.('rejected')
      }).finally(() => { active -= 1 }).catch(() => undefined)
    }
    return withinBudget(entry.promise, timeoutMs, label)
  }
  function dispose(): void { generation += 1; entries.clear(); for (const cancel of waiters) cancel(); waiters.clear() }
  return { load, dispose, withinBudget }
}

export async function loadFontFaceFromUrlWithinBudget(
  family: string,
  url: string,
  timeoutMs = QUICK_WEBFONT_URL_TIMEOUT_MS,
  settled?: (outcome: string) => void,
  owner = createFontFaceLoadOwner(),
  identity = url
): Promise<FontFace> {
  return owner.load(`${family}::${identity}::url`, () => new FontFace(family, `url("${url}")`), timeoutMs, '协议 WebFont 快速预览', settled)
}

export async function loadFontFaceFromBinaryWithinBudget(
  family: string,
  source: ArrayBuffer,
  timeoutMs = QUICK_WEBFONT_BINARY_TIMEOUT_MS,
  settled?: (outcome: string) => void,
  owner = createFontFaceLoadOwner(),
  identity = family
): Promise<FontFace> {
  return owner.load(`${family}::${identity}::binary`, () => new FontFace(family, source), timeoutMs, '二进制 WebFont 快速预览', settled)
}
