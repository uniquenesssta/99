import { getCardPreviewLayout } from '@shared/preview-layout/previewTextFitRuntime'
import { previewRecordForProbe } from '@shared/previewFailure'
import { previewTrace, previewEvent } from '../previewTraceRuntime'
import type { FontItem } from '@shared/types'
import type { PreviewQueueEntry } from '../../../appRuntime'
import {
MAX_CONCURRENT_PREVIEW_LOADS,
rendererMemoryPressure,
requestIdleWindow
} from '../../../appRuntime'
import { VISIBLE_PREVIEW_CACHE_BATCH_LIMIT, VISIBLE_PREVIEW_CACHE_WAIT_MS } from './fontPreviewBatchPolicyRuntime'
import { resolveFontPreviewRoute } from './fontPreviewRouteRuntime'
import type { FontPreviewLoadRuntime,FontPreviewQueueRuntimeOptions,FontPreviewStateRuntime,FontVisiblePreviewQueueRuntime } from './fontPreviewQueueTypes'


export function createFontVisiblePreviewQueueRuntime(
  options: FontPreviewQueueRuntimeOptions,
  stateRuntime: Pick<FontPreviewStateRuntime, 'canRequestPreviewFont'>,
  loadRuntime: FontPreviewLoadRuntime
): FontVisiblePreviewQueueRuntime {
  const demand = new Map<string, { font: FontItem; callers: Set<() => boolean> }>()
  const alwaysCurrent = () => true
  function hasDemand(id: string): boolean {
    const callers = demand.get(id)?.callers
    if (!callers) return false
    for (const caller of callers) if (!caller()) callers.delete(caller)
    if (!callers.size) demand.delete(id)
    return !!callers.size
  }
  let deferredPreviewRetryId: number | null = null
  let normalPreviewProcessScheduled = false
  let idleId: number | null = null
  let queueGeneration = 0
  let disposed = false
  let cachedPreviewBatchInFlight = false
  let cachedPreviewBatchToken = ''
  let cacheWaitTimer: number | null = null
  let cacheWaitExpired = false
  const cachedPreviewBatchCheckedIds = new Set<string>()
  const cachedPreviewBatchMissIds = new Set<string>()

  function resetVisiblePreviewQueue(keepDemand = false): void {
    queueGeneration += 1
    if (!keepDemand) demand.clear()
    cacheWaitExpired = cachedPreviewBatchInFlight
    if (cacheWaitTimer !== null) window.clearTimeout(cacheWaitTimer)
    cacheWaitTimer = null
    cachedPreviewBatchCheckedIds.clear()
    cachedPreviewBatchMissIds.clear()
    if (deferredPreviewRetryId !== null) window.clearTimeout(deferredPreviewRetryId)
    deferredPreviewRetryId = null
    if (idleId !== null) {
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idleId)
      else window.clearTimeout(idleId)
    }
    idleId = null
    normalPreviewProcessScheduled = false
  }
  function disposePreviewQueue(): void { disposed = true; resetVisiblePreviewQueue(); loadRuntime.resetPreviewLoads(); options.loadingFonts.current.clear() }
  function resumePreviewQueue(): void { disposed = false }


  function pausePreviewForScroll(): void {
    resetVisiblePreviewQueue(true)
    loadRuntime.resetPreviewLoads()
    options.loadingFonts.current.clear()
    options.previewQueue.current = []
    options.queuedPreviewFontIds.current.clear()
  }
  function resumePreviewAfterScroll(): void {
    if (disposed) return
    for (const [id, entry] of [...demand]) {
      if (!hasDemand(id)) continue
      for (const caller of entry.callers) requestPreviewFont(entry.font, 'high', caller)
    }
    processPreviewQueue()
  }

  function currentPreviewTrace(fontId: string) {
    const layout = getCardPreviewLayout(options.previewLayoutMode ?? 'list', options.previewText, options.listPreviewFontSize)
    return previewTrace(fontId, layout.text, layout.fontSize)
  }

  function currentPreviewBatchToken(): string {
    return getCardPreviewLayout(options.previewLayoutMode ?? 'list', options.previewText, options.listPreviewFontSize).token
  }

  function syncCachedPreviewBatchText(): void {
    const previewToken = currentPreviewBatchToken()
    if (cachedPreviewBatchToken === previewToken) return
    cachedPreviewBatchToken = previewToken
    cachedPreviewBatchCheckedIds.clear()
    cachedPreviewBatchMissIds.clear()
  }

  function scheduleDeferredPreviewRetry(delayMs = 420): void {
    if (!options.previewQueue.current.length || deferredPreviewRetryId !== null) return
    const generation = queueGeneration
    deferredPreviewRetryId = window.setTimeout(() => {
      if (disposed || generation !== queueGeneration) return
      deferredPreviewRetryId = null
      processPreviewQueue()
    }, delayMs)
  }

  function scheduleNormalPreviewProcess(): void {
    if (normalPreviewProcessScheduled) return
    normalPreviewProcessScheduled = true
    const generation = queueGeneration
    idleId = requestIdleWindow(() => {
      if (disposed || generation !== queueGeneration) return
      idleId = null
      normalPreviewProcessScheduled = false
      processPreviewQueue()
    }, 120)
  }

  function canBatchCheckCachedPreview(font: FontItem): boolean {
    syncCachedPreviewBatchText()
    if (cachedPreviewBatchCheckedIds.has(font.id)) return false
    if (cachedPreviewBatchMissIds.has(font.id)) return false
    const routeForcesNative = resolveFontPreviewRoute(font).shouldSkipWebFontFileLoad
    if (options.previewFamilies[font.id] && !routeForcesNative) return false
    if (options.nativePreviewImages[font.id]) return false
    if (options.loadingFonts.current.has(font.id)) return false
    if (options.isBadFontRecord(previewRecordForProbe(font))) return false
    return true
  }

  function collectCachedPreviewBatchCandidates(): FontItem[] {
    const seen = new Set<string>()
    const candidates: FontItem[] = []
    for (const entry of options.previewQueue.current) {
      const font = entry.font
      if (!font?.id || seen.has(font.id) || !canBatchCheckCachedPreview(font)) continue
      seen.add(font.id)
      candidates.push(font)
      if (candidates.length >= VISIBLE_PREVIEW_CACHE_BATCH_LIMIT) break
    }
    return candidates
  }

  function pruneCachedPreviewBatchCheckedIds(): void {
    for (const id of cachedPreviewBatchCheckedIds) {
      if (!options.queuedPreviewFontIds.current.has(id)) cachedPreviewBatchCheckedIds.delete(id)
    }
    for (const id of cachedPreviewBatchMissIds) {
      if (!options.queuedPreviewFontIds.current.has(id)) cachedPreviewBatchMissIds.delete(id)
    }
  }

  function processCachedPreviewBatchIfNeeded(): boolean {
    syncCachedPreviewBatchText()
    if (cachedPreviewBatchInFlight) return !cacheWaitExpired
    const candidates = collectCachedPreviewBatchCandidates()
    if (!candidates.length) return false

    const generation = queueGeneration
    const token = currentPreviewBatchToken()
    cachedPreviewBatchInFlight = true
    for (const font of candidates) cachedPreviewBatchCheckedIds.add(font.id)

    cacheWaitExpired = false
    let accepting = true
    const acceptsResult = (font?: FontItem) => accepting && !disposed && generation === queueGeneration && token === currentPreviewBatchToken() && (!font || hasDemand(font.id))
    cacheWaitTimer = window.setTimeout(() => {
      cacheWaitTimer = null
      accepting = false
      cacheWaitExpired = true
      if (!disposed && generation === queueGeneration) processPreviewQueue()
    }, VISIBLE_PREVIEW_CACHE_WAIT_MS)
    void loadRuntime.loadCachedNativeCardPreviews(candidates, acceptsResult)
      .then((hitIds) => {
        if (!acceptsResult()) return
        for (const font of candidates) {
          if (!hitIds.has(font.id)) cachedPreviewBatchMissIds.add(font.id)
        }
        if (!hitIds.size) return
        options.previewQueue.current = options.previewQueue.current.filter((entry) => {
          if (!hitIds.has(entry.font.id)) return true
          options.queuedPreviewFontIds.current.delete(entry.font.id)
          demand.delete(entry.font.id)
          return false
        })
      })
      .catch(() => {
        // A failed probe is a miss for this queue attempt, not a reason to probe forever.
        if (!acceptsResult()) return
        for (const font of candidates) cachedPreviewBatchMissIds.add(font.id)
      })
      .finally(() => {
        accepting = false
        if (cacheWaitTimer !== null) window.clearTimeout(cacheWaitTimer)
        cacheWaitTimer = null
        cachedPreviewBatchInFlight = false
        cacheWaitExpired = false
        if (disposed) return
        pruneCachedPreviewBatchCheckedIds()
        processPreviewQueue()
      })

    return true
  }

  function processPreviewQueue(): void {
    if (disposed || options.fontListScrollingRef.current) return
    options.previewQueue.current = options.previewQueue.current.filter(entry => {
      if (hasDemand(entry.font.id)) return true
      options.queuedPreviewFontIds.current.delete(entry.font.id)
      return false
    })
    const memory = rendererMemoryPressure()
    const userActive = options.rendererUserActive()
    if ((memory === 'hard' || userActive) && !options.previewQueue.current.some((entry) => entry.priority === 'high')) {
      scheduleDeferredPreviewRetry(memory === 'hard' ? 900 : 420)
      return
    }

    if (processCachedPreviewBatchIfNeeded()) return

    const limit = MAX_CONCURRENT_PREVIEW_LOADS

    while (options.activePreviewLoads.current < limit && options.previewQueue.current.length) {
      const entry = options.previewQueue.current.shift()
      if (!entry) continue
      const font = entry.font
      options.queuedPreviewFontIds.current.delete(font.id)
      if (!stateRuntime.canRequestPreviewFont(font)) continue

      const generation = queueGeneration
      previewEvent(currentPreviewTrace(font.id), 'load-start')
      options.activePreviewLoads.current += 1
      void loadRuntime.ensurePreviewFont(font, true, () => !disposed && hasDemand(font.id)).finally(() => {
        options.activePreviewLoads.current = Math.max(0, options.activePreviewLoads.current - 1)
        if (disposed) return
        if (generation === queueGeneration && !options.queuedPreviewFontIds.current.has(font.id)) demand.delete(font.id)
        pruneCachedPreviewBatchCheckedIds()
        processPreviewQueue()
      })
    }
  }

  function requestPreviewFont(font: FontItem, priority: 'normal' | 'high' = 'normal', acceptsResult: () => boolean = alwaysCurrent): void {
    if (disposed || !acceptsResult()) return
    const callers = demand.get(font.id)?.callers || new Set<() => boolean>()
    for (const caller of callers) if (!caller()) callers.delete(caller)
    callers.add(acceptsResult)
    demand.set(font.id, { font, callers })
    const trace = currentPreviewTrace(font.id)
    previewEvent(trace, 'request', priority)
    if (!stateRuntime.canRequestPreviewFont(font, true)) {
      if (!options.loadingFonts.current.has(font.id) && !options.queuedPreviewFontIds.current.has(font.id)) demand.delete(font.id)
      previewEvent(trace, 'admission-rejected'); return
    }
    const routeForcesNative = resolveFontPreviewRoute(font).shouldSkipWebFontFileLoad
    if ((!routeForcesNative && options.previewFamilies[font.id]) || options.nativePreviewImages[font.id] || options.loadingFonts.current.has(font.id)) return
    if (routeForcesNative && options.previewFamilies[font.id]) {
      options.setPreviewFamilies((prev) => {
        if (!prev[font.id]) return prev
        const next = { ...prev }
        delete next[font.id]
        return next
      })
    }

    if (options.queuedPreviewFontIds.current.has(font.id)) {
      if (priority === 'high') {
        const entryIndex = options.previewQueue.current.findIndex((entry) => entry.font.id === font.id)
        if (entryIndex >= 0) {
          const [entry] = options.previewQueue.current.splice(entryIndex, 1)
          options.previewQueue.current.unshift({ ...entry, priority: 'high' })
        }
        processPreviewQueue()
      }
      return
    }

    previewEvent(trace, 'queued', priority)
    options.queuedPreviewFontIds.current.add(font.id)
    cachedPreviewBatchCheckedIds.delete(font.id)
    const entry: PreviewQueueEntry = { font, priority }
    if (priority === 'high') {
      options.previewQueue.current.unshift(entry)
      processPreviewQueue()
    } else {
      options.previewQueue.current.push(entry)
      scheduleNormalPreviewProcess()
    }
  }

  return {
    resetVisiblePreviewQueue,
    pausePreviewForScroll,
    resumePreviewAfterScroll,
    disposePreviewQueue,
    resumePreviewQueue,
    processPreviewQueue,
    requestPreviewFont
  }
}
